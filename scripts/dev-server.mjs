// Minimal zero-dependency static server for the built web UI (dist/ui).
// Used by `npm run dev` so Kimi Work (or a human) can preview the app.
// Forwards --port/--host CLI args and PORT/HOST env vars.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../dist/ui", import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=")[1];
  return fallback;
}

const port = Number(arg("port", process.env.PORT ?? 7100));
const host = arg("host", process.env.HOST ?? "0.0.0.0");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let path = normalize(join(root, url === "/" ? "index.html" : url));
    if (!path.startsWith(root)) throw new Error("forbidden");
    let body = await readFile(path).catch(async () => {
      // SPA fallback: unknown paths serve index.html
      path = join(root, "index.html");
      return readFile(path);
    });
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found — did you run the build? (npm run build:ui)");
  }
}).listen(port, host, () => {
  console.log(`Bit2AtomBot dev server: http://${host}:${port}/ (serving dist/ui)`);
});
