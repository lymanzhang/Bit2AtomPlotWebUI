/**
 * Backend web server for controlling the EBB.
 * Serve both the front end UI as static files - made with React, and backend
 * API for controlling the EBB.
 * Keep open web sockets to the front end for real-time updates.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { autoDetect } from "@serialport/bindings-cpp";
import type { PortInfo } from "@serialport/bindings-interface";
import cors from "cors";
import type { Request, Response } from "express";
import express from "express";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";
import { EBB, type Hardware } from "./ebb.js";
import { type Motion, type MotionData, PenMotion, Plan, rewindTravelMotion, snapToGroupStart, getDevice, XYMotion } from "./planning.js";
import { startRunLog } from "./run-log.js";
import type { Vec2 } from "./vec.js";
import { SerialPortSerialPort } from "./serialport-serialport.js";
import * as _self from "./server.js"; // use self-import for test mocking
import { formatDuration } from "./util.js";

type Com = string;

/**
 * Shorthand for getting the device info, either EBB or com port.
 * @param ebb
 * @returns
 */
const getDeviceInfo = (ebb: EBB | null) => {
  const portPath = (ebb?.port as any)?._path ?? null;
  return { path: portPath, hardware: ebb?.hardware ?? "v3" };
};

/**
 * Start the express server.
 * @param port
 * @param hardware
 * @param com
 * @param enableCors
 * @param maxPayloadSize
 * @returns
 */
export async function startServer(
  port: number,
  hardware: Hardware = "v3",
  com: Com = "",
  enableCors = false,
  maxPayloadSize = "200mb",
) {
  startRunLog();
  const app = express();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  app.use("/", express.static(path.join(__dirname, "..", "ui")));
  app.use(express.json({ limit: maxPayloadSize }));
  if (enableCors) {
    app.use(cors());
  }
  // Web and Socket server
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  let ebb: EBB | null;
  let clients: WebSocket[] = [];
  let unpaused: Promise<void> | null = null;
  let signalUnpause: (() => void) | null = null;
  let motionIdx: number | null = null;
  let currentPlan: Plan | null = null;
  let plotting = false;
  let controller: AbortController | null = null;
  // When set, resuming from a pause will rewind the plan to this motion
  // index (snapped to a path-group start) and redraw from there.
  let pendingRewind: number | null = null;
  // Pen position across plots, for redraw-range runs. After a normal finish
  // it is the plan's final travel destination; after a cancel it is the plan's
  // initial pen home (HM). Null after server start (position unknown).
  let lastPenPos: Vec2 | null = null;
  // Serialized plan of the last plot, kept after completion for /redraw.
  let lastPlan: MotionData[] | null = null;
  // The "wake lock unavailable" reminder is informational; only print it once.
  let wakeLockReminderShown = false;

  wss.on("connection", (ws) => {
    clients.push(ws);
    ws.on("message", (message) => {
      let msg: { c: string; p?: Record<string, unknown> };
      try {
        msg = JSON.parse(message.toString());
      } catch (e) {
        console.warn("Received malformed WebSocket message:", (e as Error).message);
        return;
      }
      switch (msg.c) {
        case "ping":
          ws.send(JSON.stringify({ c: "pong" }));
          break;
        case "limp":
          if (ebb) {
            // 挂起的 rejection 无人处理会成为 unhandled rejection，务必捕获。
            ebb.disableMotors().catch((e) => console.error("Limp failed:", e));
          }
          break;
        case "setPenHeight":
          if (ebb) {
            (async () => {
              // 超时兜底：绘制中该命令会排在绘图命令之后，取宽裕的 60s；
              // 队列卡死时至少能在日志中看到失败而不是静默挂起。
              if (await withTimeout(ebb.supportsSR(), 60000, "supportsSR")) {
                await withTimeout(ebb.setServoPowerTimeout(10000, true), 60000, "setServoPowerTimeout");
              }
              await withTimeout(ebb.setPenHeight(msg.p.height as number, msg.p.rate as number), 60000, "setPenHeight");
            })().catch((e) => console.error("Set pen height failed:", e));
          }
          break;
        case "changeHardware":
          ebb?.changeHardware(msg.p.hardware as Hardware);
          broadcast({ c: "dev", p: { path: (ebb?.port as any)?._path ?? null, hardware: msg.p.hardware } });
          break;
      }
    });

    // send starting params to clients
    ws.send(JSON.stringify({ c: "dev", p: getDeviceInfo(ebb) }));

    ws.send(JSON.stringify({ c: "pause", p: { paused: !!unpaused } }));
    if (motionIdx != null) {
      ws.send(JSON.stringify({ c: "progress", p: { motionIdx } }));
    }
    if (currentPlan != null) {
      ws.send(JSON.stringify({ c: "plan", p: { plan: currentPlan } }));
    }

    ws.on("close", () => {
      clients = clients.filter((w) => w !== ws);
    });
  });

  /**
   * /plot POST endpoint. Receive a plan on the POST body, and execute it.
   */
  app.post("/plot", async (req: Request, res: Response) => {
    if (plotting) {
      console.log("Received plot request, but a plot is already in progress!");
      res.status(400).send("Plot in progress");
      return;
    }
    plotting = true;
    controller = new AbortController();
    const { signal } = controller;
    try {
      const plan = Plan.deserialize(req.body);
      currentPlan = req.body;
      lastPlan = req.body;
      console.log(`Received plan of estimated duration ${formatDuration(plan.duration())}`);
      console.log(ebb != null ? "Beginning plot..." : "Simulating plot...");
      res.status(200).end();

      const begin = Date.now();
      let wakeLock: { release(): void } | null = null;

      // The wake-lock module is macOS-only. Log the reminder once per process,
      // not on every plot — it's informational, not an error.
      if (process.platform === "darwin") {
        try {
          // Dynamically import wake-lock only on macOS
          const { WakeLock } = await import("wake-lock");
          wakeLock = new WakeLock("Bit2AtomBot plotting");
        } catch (_error) {
          console.warn("Couldn't acquire wake lock. Ensure your machine does not sleep during plotting");
        }
      } else if (!wakeLockReminderShown) {
        wakeLockReminderShown = true;
        console.log("Wake lock not available on this platform. Ensure your machine does not sleep during plotting");
      }
      try {
        await doPlot(ebb != null ? realPlotter : simPlotter, plan, signal);
        const end = Date.now();
        console.log(`Plot took ${formatDuration((end - begin) / 1000)}`);
      } catch (e) {
        // 兜底：此时 200 响应已发出，无法再改状态码；串口命令超时等
        // 失败若无人处理会成为 unhandled rejection。记录错误并广播
        // cancelled，让 UI 退出绘制状态（doPlot 的 finally 已清 motionIdx）。
        console.error("Plot failed:", e);
        broadcast({ c: "cancelled" });
      } finally {
        if (wakeLock) {
          wakeLock.release();
        }
      }
    } finally {
      plotting = false;
      controller = null;
    }
  });

  app.get("/plot/status", (_req, res) => {
    res.json({ plotting });
  });

  app.post("/cancel", (_req: Request, res: Response) => {
    if (controller) {
      controller.abort();
      controller = null;
    }
    ebb?.cancel();
    pendingRewind = null;
    if (unpaused) {
      signalUnpause?.();
      broadcast({ c: "pause", p: { paused: false } });
    }
    unpaused = signalUnpause = null;
    res.status(200).end();
  });

  app.post("/pause", (_req: Request, res: Response) => {
    if (!unpaused) {
      unpaused = new Promise((resolve) => {
        signalUnpause = resolve;
      });
      broadcast({ c: "pause", p: { paused: true } });
    }
    res.status(200).end();
  });

  app.post("/resume", (req: Request, res: Response) => {
    // Optional body: { rewindTo: motionIdx }. When present and the plan is
    // paused, execution rewinds to the nearest path-group start at or before
    // rewindTo (a pen-up travel move is inserted to get there safely) and
    // redraws from that point — useful to re-ink paths missed by a clogged pen.
    if (unpaused) {
      const rewindTo = req.body?.rewindTo;
      pendingRewind = typeof rewindTo === "number" && Number.isFinite(rewindTo) && rewindTo >= 0 ? rewindTo : null;
      signalUnpause();
      signalUnpause = unpaused = null;
    }
    res.status(200).end();
  });

  app.post("/redraw", async (req: Request, res: Response) => {
    // Body: { from: motionIdx, to: motionIdx } — after a finished (or
    // cancelled) plot, replay only the path groups covering [from, to).
    // Used to patch missing strokes without redoing the whole drawing.
    if (plotting) {
      console.log("Received redraw request, but a plot is already in progress!");
      res.status(400).send("Plot in progress");
      return;
    }
    if (!lastPlan) {
      res.status(409).send("没有可补画的任务：请先完成一次绘制");
      return;
    }
    if (lastPenPos == null) {
      res.status(409).send("笔当前位置未知（服务可能刚重启）。请先执行「笔回原点」后再补画");
      return;
    }
    const from = Number(req.body?.from);
    const to = Number(req.body?.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from) {
      res.status(400).send("无效的补画区间");
      return;
    }
    plotting = true;
    controller = new AbortController();
    const { signal } = controller;
    res.status(200).end();
    const begin = Date.now();
    try {
      const plan = Plan.deserialize(lastPlan);
      console.log(`Redrawing motions [${from}, ${to})`);
      await doPlot(ebb != null ? realPlotter : simPlotter, plan, signal, { redrawFrom: from, redrawTo: to });
      console.log(`Redraw took ${formatDuration((Date.now() - begin) / 1000)}`);
      // 补画完成后自动归位：方便取纸检查，且保证位置跟踪始终已知，
      // 下次补画无需手动「笔回原点」。
      console.log("Auto-homing after redraw...");
      try {
        await homePenNow(plan);
      } catch (e) {
        const message = `补画后自动归位失败：${(e as Error).message}。请点击「笔回原点」重试；若仍失败，请重新连接设备后再试。`;
        console.error(message);
        broadcast({ c: "home-failed", p: { message } });
      }
    } catch (e) {
      // 同 /plot：防止 async rejection 使进程崩溃，并让 UI 退出绘制状态。
      console.error("Redraw failed:", e);
      broadcast({ c: "cancelled" });
    } finally {
      plotting = false;
      controller = null;
    }
  });

  // Reject if the underlying promise neither resolves nor rejects within ms.
  // EBB serial commands otherwise wait forever on a missed response, which
  // would wedge `plotting` and silently swallow later /home requests.
  function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      p.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  // Lift the pen and return the carriage to the plan's pen home.
  // IMPORTANT: this must NOT use the HM command. HM moves to the EBB's
  // absolute origin, which is reset to the CURRENT position whenever the
  // motors are re-enabled (EM). By the time we get here, postPlot has already
  // disabled the motors, so enableMotors() + HM is a zero-length no-op —
  // the pen stays put and HM even reports instant success. (Homing only
  // works via HM when the motors have stayed enabled since the plot began,
  // which is why postCancel's HM does work.) Instead, travel home the same
  // way the redraw initial travel does: a pen-up XY motion in plan space
  // from the tracked lastPenPos, which does not depend on EBB origin state.
  // Throws on failure instead of swallowing the error, so /home can return a
  // 500 (UI alert) and /redraw can broadcast the failure to the UI.
  async function homePenNow(plan: Plan | null): Promise<void> {
    let home: Vec2 = { x: 0, y: 0 };
    if (ebb) {
      // 分步耗时统计：归位是补画后的关键恢复环节，输出每步耗时便于
      // 监控性能与定位偶发卡顿（如 travel 异常变慢 = 机械阻力/固件问题）。
      const homeStart = Date.now();
      const stepTimes: string[] = [];
      let stepStart = homeStart;
      const markStep = (label: string) => {
        const now = Date.now();
        stepTimes.push(`${label} ${((now - stepStart) / 1000).toFixed(1)}s`);
        stepStart = now;
      };
      try {
        // 通信探活：若命令队列因丢失响应而卡死，后续命令会永远排队、
        // 笔一动不动且无任何报错。先用短超时探测；失败则清空队列
        // （等一个沉降期让孤儿响应排空）后重试一次，仍失败则明确抛错。
        try {
          await withTimeout(ebb.query("QM"), 5000, "通信探测(QM)");
        } catch (probeErr) {
          console.warn("Home probe failed, flushing command queue and retrying once...", probeErr);
          ebb.cancel();
          await new Promise((resolve) => setTimeout(resolve, 700)); // 覆盖 500ms 沉降期
          await withTimeout(ebb.query("QM"), 5000, "通信探测重试(QM)");
          console.log("Home probe recovered after queue flush.");
        }
        markStep("probe");
        const firstXY = plan?.motions.find((m): m is XYMotion => m instanceof XYMotion);
        if (firstXY) home = firstXY.p1;
        const device = getDevice(ebb.hardware);
        const penMotion = plan?.motions.find((m): m is PenMotion => m instanceof PenMotion);
        const penUp = penMotion ? Math.max(penMotion.initialPos, penMotion.finalPos) : device.penPctToPos(50);
        console.log("Home: lifting pen...");
        await withTimeout(ebb.setPenHeight(penUp, 1000), 15000, "setPenHeight");
        markStep("pen");
        console.log("Home: enabling motors...");
        await withTimeout(ebb.enableMotors(1), 15000, "enableMotors"); // 16x microstepping, matches prePlot
        markStep("motors");
        if (plan != null && lastPenPos != null && (lastPenPos.x !== home.x || lastPenPos.y !== home.y)) {
          console.log(`Home: travelling to pen home from (${lastPenPos.x}, ${lastPenPos.y})...`);
          const travel = rewindTravelMotion(plan, lastPenPos, home);
          await withTimeout(ebb.executeMotion(travel), 150000, "travelHome");
        } else if (lastPenPos == null) {
          // 位置未知（如服务重启后未绘制过）：无法构造安全的行程移动，
          // 只能尽力用 HM——若 EBB 的原点恰好未被重置（电机未经历关开循环）
          // 它仍会归位，否则为空操作。真正的恢复手段是重新对齐机械原点。
          console.log("Home: position unknown, best-effort HM...");
          await withTimeout(ebb.command("HM,4000"), 150000, "HM");
        } else {
          console.log("Home: pen already at home, no travel needed.");
        }
        markStep("travel");
        console.log("Home: waiting for motors to idle...");
        await withTimeout(ebb.waitUntilMotorsIdle(140000), 150000, "waitUntilMotorsIdle");
        markStep("idle");
        console.log("Home: disabling motors...");
        await withTimeout(ebb.disableMotors(), 15000, "disableMotors");
        markStep("disable");
        lastPenPos = home;
        console.log(`Home: done in ${((Date.now() - homeStart) / 1000).toFixed(1)}s (${stepTimes.join(", ")}).`);
      } catch (e) {
        console.error(`Home failed after ${((Date.now() - homeStart) / 1000).toFixed(1)}s (${stepTimes.join(", ")}):`, e);
        // 归位失败时位置不可信，标记为未知（下次补画前需重新归位），
        // 并清空可能卡死的命令队列，让后续命令可以重新尝试。
        lastPenPos = null;
        ebb.cancel();
        // 归位中止时电机可能仍处于使能状态（锁轴），尽量关闭。
        try {
          await withTimeout(ebb.disableMotors(), 5000, "disableMotors(fallback)");
        } catch {
          /* ignore */
        }
        throw e;
      }
    } else {
      lastPenPos = home;
    }
  }

  app.post("/home", async (_req: Request, res: Response) => {
    if (plotting) {
      res.status(400).send("Plot in progress");
      return;
    }
    try {
      const plan = lastPlan ? Plan.deserialize(lastPlan) : null;
      await homePenNow(plan);
      res.status(200).end();
    } catch (e) {
      res.status(500).send(`归位失败：${(e as Error).message}`);
    }
  });

  function broadcast(msg: Record<string, unknown>) {
    for (const client of clients) {
      try {
        client.send(JSON.stringify(msg));
      } catch (e) {
        console.warn(e);
      }
    }
  }

  interface Plotter {
    prePlot: (initialPenHeight: number) => Promise<void>;
    executeMotion: (m: Motion, progress: [number, number]) => Promise<void>;
    postCancel: (initialPenHeight: number) => Promise<void>;
    postPlot: () => Promise<void>;
  }

  const realPlotter: Plotter = {
    async prePlot(initialPenHeight: number): Promise<void> {
      // 全部命令加超时：若串口命令队列已卡死（如上次归位失败遗留），
      // 这些命令会永远挂起且 plotting 卡在 true，后续一切请求被拒。
      // 超时快速失败，由 /plot 的 catch 兜底复位并通知 UI。
      await withTimeout(ebb.configureFifoDepth(), 15000, "prePlot:configureFifoDepth");
      await withTimeout(ebb.enableMotors(1), 15000, "prePlot:enableMotors"); // 16x microstepping, matches defaults from Axidraw
      await withTimeout(ebb.setPenHeight(initialPenHeight, 1000, 1000), 15000, "prePlot:setPenHeight");
    },
    async executeMotion(motion: Motion, _progress: [number, number]): Promise<void> {
      // 单动作超时兜底：LM/XM 指令在 EBB FIFO 接受后即返回（毫秒级），
      // 150s 只会在队列卡死时触发；doPlot 中该 await 仍与 abortPromise 竞速，
      // 超时让循环带错退出而不是永久挂起。
      await withTimeout(ebb.executeMotion(motion), 150000, "executeMotion");
    },
    async postCancel(initialPenHeight: number): Promise<void> {
      // The board may still be executing motion queued in its FIFO; issuing
      // HM while moving makes the steppers grind against whatever they're doing.
      // waitUntilMotorsIdle 传 60s：取消时 FIFO 中可能还排着多条动作，
      // 内部默认 30s 对大 FIFO 不够。队列卡死时这些超时保证 plotting 复位。
      await withTimeout(ebb.waitUntilMotorsIdle(60000), 65000, "postCancel:waitUntilMotorsIdle");
      await withTimeout(ebb.setPenHeight(initialPenHeight, 1000), 15000, "postCancel:setPenHeight");
      // 此处 HM 是安全的：绘制全程电机保持使能，EBB 原点未被重置（见 homePenNow 注释）。
      await withTimeout(ebb.command("HM,4000"), 150000, "postCancel:HM"); // HM returns carriage home without 3rd and 4th arguments
    },
    async postPlot(): Promise<void> {
      await withTimeout(ebb.waitUntilMotorsIdle(60000), 65000, "postPlot:waitUntilMotorsIdle");
      await withTimeout(ebb.disableMotors(), 15000, "postPlot:disableMotors");
    },
  };

  const simPlotter: Plotter = {
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async prePlot(_initialPenHeight: number): Promise<void> {},
    async executeMotion(motion: Motion, progress: [number, number]): Promise<void> {
      console.log(`Motion ${progress[0] + 1}/${progress[1]}`);
      await new Promise((resolve) => setTimeout(resolve, motion.duration() * 1000));
    },
    async postCancel(_initialPenHeight: number): Promise<void> {
      console.log("Plot cancelled");
    },
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    async postPlot(): Promise<void> {},
  };

  async function doPlot(
    plotter: Plotter,
    plan: Plan,
    signal: AbortSignal,
    opts?: { redrawFrom?: number; redrawTo?: number },
  ): Promise<void> {
    const abortPromise = onceAbort(signal); // reuse abort promise
    unpaused = null;
    signalUnpause = null;
    pendingRewind = null;
    motionIdx = 0;

    // Redraw-range mode: replay only the path groups covering [redrawFrom,
    // redrawTo) instead of the whole plan, after travelling safely to the
    // start of the range.
    const redrawFrom = typeof opts?.redrawFrom === "number" ? opts.redrawFrom : null;
    const redrawTo = typeof opts?.redrawTo === "number" ? opts.redrawTo : null;
    const isRedraw = redrawFrom != null && redrawTo != null;
    const endIdx = isRedraw ? Math.max(0, Math.min(redrawTo, plan.motions.length)) : plan.motions.length;

    const firstPenMotion = plan.motions.find((x) => x instanceof PenMotion) as PenMotion | undefined;
    if (!firstPenMotion) {
      throw new Error("Plan contains no PenMotion; cannot determine initial pen height");
    }
    await plotter.prePlot(firstPenMotion.initialPos);

    let penIsUp = true;
    try {
      // Current pen position. For a fresh plot the pen starts at the plan's
      // initial pen home (p1 of the first travel move); for a redraw-range run
      // it resumes from wherever the previous run left it (tracked across
      // plots by |lastPenPos|).
      let curPos: Vec2 | null = null;
      if (isRedraw) {
        curPos = lastPenPos;
      } else {
        for (const m of plan.motions) {
          if (m instanceof XYMotion) {
            curPos = m.p1;
            break;
          }
        }
      }
      lastPenPos = curPos;

      let idx = isRedraw ? snapToGroupStart(plan, redrawFrom) : 0;

      // Redraw mode: safe pen-up travel from the parked position to the
      // start of the requested range before replaying it.
      if (isRedraw && curPos != null) {
        const goal = plan.motions[idx];
        if (goal instanceof XYMotion && (goal.p1.x !== curPos.x || goal.p1.y !== curPos.y)) {
          const travel = rewindTravelMotion(plan, curPos, goal.p1);
          await Promise.race([plotter.executeMotion(travel, [idx, endIdx]), abortPromise]);
          curPos = goal.p1;
          lastPenPos = curPos;
        }
      }

      while (idx < endIdx) {
        const motion = plan.motions[idx];
        motionIdx = idx;
        broadcast({ c: "progress", p: { motionIdx: idx } });

        await Promise.race([plotter.executeMotion(motion, [idx, endIdx]), abortPromise]);

        if (motion instanceof XYMotion) {
          curPos = motion.p2;
          lastPenPos = curPos;
        }
        if (motion instanceof PenMotion) {
          penIsUp = motion.initialPos < motion.finalPos;
        }

        if (unpaused && penIsUp) {
          await Promise.race([unpaused, abortPromise]);
          // Resumed. If a rewind was requested, safely travel (pen up) to
          // the start of the target path group and redraw from there.
          // (pause:false must be broadcast on every resume path — including
          // rewinds — so the UI leaves the paused state and can pause/rewind
          // again during the redraw.)
          if (pendingRewind != null && curPos != null) {
            const target = snapToGroupStart(plan, pendingRewind);
            pendingRewind = null;
            if (target < idx) {
              const goal = plan.motions[target];
              if (goal instanceof XYMotion) {
                broadcast({ c: "pause", p: { paused: false } });
                const travel = rewindTravelMotion(plan, curPos, goal.p1);
                await Promise.race([plotter.executeMotion(travel, [idx, endIdx]), abortPromise]);
                curPos = goal.p1;
                lastPenPos = curPos;
                idx = target;
                continue;
              }
            }
          }
          pendingRewind = null;
          broadcast({ c: "pause", p: { paused: false } });
        }

        idx += 1;
      }

      broadcast({ c: "finished" });
    } catch (err) {
      if (signal.aborted) {
        await plotter.postCancel(firstPenMotion.initialPos);
        // The pen was homed (HM), which is the plan's initial pen home.
        for (const m of plan.motions) {
          if (m instanceof XYMotion) {
            lastPenPos = m.p1;
            break;
          }
        }
        broadcast({ c: "cancelled" });
        return;
      }
      throw err; // propagate real errors
    } finally {
      motionIdx = null;
      currentPlan = null;
      await plotter.postPlot();
    }
  }

  function onceAbort(signal: AbortSignal): Promise<never> {
    return new Promise((_resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  }

  return new Promise<http.Server>((resolve) => {
    server.listen(port, () => {
      async function connect() {
        const devices = ebbs(com, hardware);
        for await (const device of devices) {
          ebb = device;
          broadcast({ c: "dev", p: getDeviceInfo(ebb) });
        }
      }
      connect();
      const { family, address, port } = server.address() as AddressInfo;
      const addr = `${family === "IPv6" ? `[${address}]` : address}:${port}`;
      console.log(`Server listening on http://${addr}`);
      resolve(server);
    });
  });
}

async function tryOpen(com: Com) {
  const port = new SerialPortSerialPort(com);
  await port.open({ baudRate: 9600 });
  return port;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isEBB(p: PortInfo): boolean {
  return (
    p.manufacturer === "SchmalzHaus" ||
    p.manufacturer === "SchmalzHaus LLC" ||
    (p.vendorId === "04D8" && p.productId === "FD92")
  );
}

async function listEBBs() {
  const Binding = autoDetect();
  const ports = await Binding.list();
  return ports.filter(isEBB).map((p: { path: string }) => p.path);
}

export async function waitForEbb(): Promise<Com> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ebbs = await listEBBs();
    if (ebbs.length) {
      return ebbs[0];
    }
    await sleep(5000);
  }
}

async function* ebbs(path?: string, hardware: Hardware = "v3") {
  while (true) {
    try {
      const com: Com = path || (await _self.waitForEbb()); // use self-import for test mocking
      console.log(`Found EBB at ${com}`);
      const port = await tryOpen(com);
      const closed = new Promise((resolve) => {
        port.addEventListener("disconnect", resolve, { once: true });
      });
      yield new EBB(port, hardware);
      await closed;
      yield null;
      console.error("Lost connection to EBB, reconnecting...");
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(`Error connecting to EBB: ${err.message}`);
      console.error("Retrying in 5 seconds...");
      await sleep(5000);
    }
  }
}

export async function connectEBB(hardware: Hardware, device?: string): Promise<EBB | null> {
  const dev = device ?? (await listEBBs())[0];
  if (!dev) return null;

  const port = await tryOpen(dev);
  return new EBB(port, hardware);
}
