# 更新日志（Changelog）

本项目所有值得关注的变更都记录在此文件中。

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **任务日志记录暂停/恢复/回溯事件与任务尾 FIFO 深度**：`/resume` 现写入任务日志（含回溯目标动作），暂停回溯执行时记录「进度 起点 → 目标（抬笔行程 xx mm）」；任务尾补充记录结束时的 FIFO 深度（任务头记录时设备可能尚未配置，首个任务显示「未配置」属记录时机问题）。源于 cloud03 长任务实测：日志中回溯只能靠进度回跳推断，现显式留痕

### Fixed

- **模拟模式（无设备）下 `/plot` 必现崩溃**：doPlot 排空超时估计直接调用 `ebb.estimateMotionDurationSec`，模拟模式（未连接设备或连接失败）下 `ebb` 为 null，报 `TypeError: Cannot read properties of undefined (reading 'estimateMotionDurationSec')`。现加空值保护（模拟模式无设备侧积压，估 0 → 60s 排空下限）；新增模拟模式回归测试（v0.19.0 冒烟测试发现，测试套件此前全部走 mock 串口未覆盖该路径）

## [0.19.0] - 2026-09-08

> 已发布至 [GitHub Releases](https://github.com/lymanzhang/Bit2AtomPlotWebUI/releases/tag/v0.19.0)（tag `v0.19.0`，附件 `bit2atombot-0.19.0-src.zip`）。发布流程与注意事项见 [docs/RELEASE.md](docs/RELEASE.md)。

### Added

- **绘制任务日志（按文件归档）**：每次 `/plot` / `/redraw` 自动在 `logs/` 下生成与源文件同名的任务日志（`logs/[源文件名]__<时间戳>.log`），任务头记录源文件、任务模式、图层过滤方式与绘制图层、硬件与端口、FIFO 深度、动作总数、预计时长、预计绘制距离、计划最大速度与开始时间，过程记录包含进度心跳、暂停/恢复/取消与错误诊断（含超时后 `QM` 状态探测），任务尾汇总实际时长、实际绘制距离与结束状态；绘制过程中的终端输出自动同步进日志。`BIT2ATOM_LOG_DIR` 与 `BIT2ATOM_NO_FILE_LOG=1` 对任务日志同样生效
- **图层信息记录**：前端捕获图层过滤模式与选中图层，经 `X-Plot-Layers` 请求头传递给服务端写入任务日志，分层绘制的文件可按图层追溯任务
- **排版设置（placement）**：新增水平/垂直定位锚点（左中右 × 上中下），`自定义` 时可设置 X/Y 偏移；「适应页面」与「对齐边距」两种缩放模式均支持锚点排版；UI 中排版设置从「更多设置」独立为「纸张设置」下方分区

### Fixed

- **绘制中途 `executeMotion timed out after 150000ms` 后笔不抬起、命令队列错位**：单条 LM 命令的应答丢失或设备运动引擎停摆会让命令队列头永久挂起，而响应按入队顺序匹配，之后所有命令（包括抬笔、断使能兜底）的响应全部错位无法送达；motion 循环中止又导致计划末尾的抬笔命令永远发出。现运动命令超时后自动清空命令队列并等过 500ms 沉降期（孤儿应答被丢弃），随后收尾流程的抬笔/断使能兜底可正确送达设备；出错路径的排空等待改用 60s 短超时（不再按计划总时长长等）；超时后探测并打印设备 `QM` 状态便于定位
- **LM 速率编码溢出防护**：EBB 步进速率寄存器为 32 位相位累加器（25kHz tick），最大可表示 25000 步/s；超出时编码值溢出为负、可能导致引擎停摆。现对超限速率钳制并告警（每次会话提示一次）
- **高密度图形绘制结束时报「电机未归位」超时**：EBB 固件 ≥3.0 启用深运动 FIFO 后，`LM` 命令进入设备侧队列即应答，主机可领先物理绘制最多 depth 条动作；绘制/补画/取消结束时设备可能仍有大量积压（短动作密集的图形尤为明显，实测 `cloud13.svg` 预计 1h50m 的计划在发完全部动作后 60s 内无法排空）。`postPlot`/`postCancel` 及浏览器直连驱动的排空等待原为固定 60s，导致绘制实际正常进行却被误报 `Timed out after 60000ms waiting for motors to go idle`。现排空超时按计划总时长 + 60s 裕量动态计算；排空失败（真正的设备异常）时先尽力抬笔（此前笔会一直压在出错位置）再断使能，最后才报错
- **单条长动作被固定 150s 超时误杀**：FIFO=1 时主机同步等待设备画完，单条长动作（超长路径或被速率钳制减速的高速行程）真实耗时可达数十分钟，固定 150s 上限会在设备正常绘制中报 `executeMotion timed out`（实测 `cloud13.svg` 第 3/5 条动作被误杀，超时后 `QM=0,0,0,0` 即设备其实已画完）。现按钳制后的估计时长（`estimateMotionDurationSec`）+ 60s 裕量动态计算超时，150s 仅作短动作卡死检测下限
- **任务日志绘制距离与 UI 显示不一致（754.9 m vs 151.0 m）**：两处错误叠加——服务端按动作首尾直线距离累加（对上万短段组成的复合路径会低估数百倍，且未按 block 累加），且 Plan 坐标处于全步进空间（mm×stepsPerMm）直接当毫米统计（数值恰被放大 stepsPerMm 倍，实测差 5 倍）。现按 block 累加路径长度并除以步进密度换算，与 UI 端 `Plan.totalDistance` 算法一致
- **stepsPerMm 请求头缺失时的兜底**：前端经 `X-Plot-Steps-Per-Mm` 请求头向服务端传递计划步进密度（custom 硬件的传动参数只有前端知道）；`/plot` 与 `/redraw` 两接口在请求头缺失或非法时均按硬件档案（内置预设或 v3 默认）兜底，并打印告警提示 custom 硬件下任务日志的距离/速度可能不准
- **标尺刻度数字在缩放/平移拖拽中被选中变蓝**：预览画布与标尺指针按下时阻止浏览器文本选择（`user-select: none` + `preventDefault`），刻度数字不再随拖拽高亮

### 升级说明

直接替换旧版目录即可，配置与计划文件无格式变更；排版设置为新增可选项，缺省行为与旧版一致。若受长时绘制（单条长动作/深 FIFO 图形）误报超时困扰，本版本将显著改善；任务日志默认写入 `logs/`，便于按源文件追溯每次绘制任务。

## [0.18.0] - 2026-09-07

> 已发布至 [GitHub Releases](https://github.com/lymanzhang/Bit2AtomPlotWebUI/releases/tag/v0.18.0)（tag `v0.18.0`，附件 `bit2atombot-0.18.0-src.zip`）。发布流程与注意事项见 [docs/RELEASE.md](docs/RELEASE.md)。

### Fixed

- **串口写入失败导致服务静默崩溃**：绘制进行一段时间后 USB 瞬断/驱动错误（Windows 报 `Writing to COM port (GetOverlappedResult): Unknown error code 31`）时，EBB 命令层不等待串口写入结果，错误以 unhandled rejection 泄漏，Node 默认视为致命错误直接终止进程——长时绘制中服务静默退出。现写入失败会立即以真实原因 reject 所有挂起命令（进入既有的超时/错误广播链，绘制中止并提示），读流错误同样不再 re-throw；串口适配层补挂 `error` 事件监听；服务端另加 `unhandledRejection` 日志兜底，杂散 rejection 不再杀死进程。回归测试覆盖「写入失败→命令拒绝→无 unhandled rejection」
- **复合路径矩阵变换丢失（Affinity 导出文件拆成两块）**：`readSvg()` 此前依赖非标准的 `SVGPathElement.getPathData()` 统计复合路径子路径数——该方法在浏览器中并不存在（flatten-svg 的 polyfill 只导出独立函数、不改写原型），子路径数恒退化为 1，导致单个 `<path>` 含大量 `M` 子路径的文件（Affinity 典型导出格式）除第一个子路径外全部未应用 `<g>` 变换矩阵，预览/绘制结果被拆成两块。现改为直接解析 `d` 属性中的 `M`/`m` 命令计数，所有子路径均正确应用变换

### Added

- **运行日志落盘**：服务端每次启动自动将日志写入 `logs/bit2atombot-<日期>-<时间>.log`，每行带本地时间戳与级别（INFO/WARN/ERROR），包含绘制/补画耗时、归位分步耗时、通信探活等性能数据，便于事后分析评估；自动保留最近 50 个文件。`BIT2ATOM_LOG_DIR` 可自定义目录，`BIT2ATOM_NO_FILE_LOG=1` 可禁用

### 升级说明

直接替换旧版目录即可，配置与计划文件无格式变更。若受「绘制中服务静默崩溃」困扰，本版本的串口错误兜底将显著提升长时绘制稳定性；Affinity 导出的 SVG 无需预处理即可正确加载。

## [0.17.2] - 2026-09-01

> 已发布至 [GitHub Releases](https://github.com/lymanzhang/Bit2AtomPlotWebUI/releases/tag/v0.17.2)（tag `v0.17.2`，附件 `bit2atombot-0.17.2-src.zip`）。发布流程与注意事项见 [docs/RELEASE.md](docs/RELEASE.md)。

### 发布备注

- **发布包 zip 修复**：原 `Compress-Archive` 打包的 zip 条目使用反斜杠路径分隔符（违反 zip 规范），Linux/macOS 解压后无法使用；发布前改用 .NET `ZipArchive` 以正斜杠条目重新打包（84 个条目验证通过，0.6 MB），并同步了最新 README/CHANGELOG 进包

### Fixed

- **补画后自动归位失效**：v0.17.1 中补画完成后笔停在终点不归位（日志显示 `Home: done` 但笔不动）。根因是 EBB 固件的 `EM`（使能电机）命令会重置位置计数——补画开头的电机关-开循环使 EBB"绝对原点"变为补画起点，`HM` 归位成为零移动空操作。修复为改用基于应用层已知位置的抬笔行程移动（`rewindTravelMotion` 生成 `LM` 命令），不依赖 EBB 原点状态；仅位置完全未知时才尽力尝试 `HM`
- **命令队列静默卡死**：EBB 串口命令队列因丢失响应而卡死时，命令永远排队、笔一动不动且无任何报错。归位前现用 `QM` 短超时探活，失败则清空队列（留 700ms 沉降期）后重试一次，仍失败才明确报错
- **异步异常导致 UI 卡死/进程崩溃**：服务端 `/plot`、`/redraw` 接口与浏览器端 `plot()` / `redraw()` / `setPenHeight()` / `limp()` 全部增加异常捕获与超时控制，命令失败时正确复位状态、弹窗提示用户，杜绝 unhandled rejection

### Added

- **断连保护（浏览器直连模式）**：绘制中拔出 USB 或串口断开时，立即清空挂起的 EBB 命令、中止绘制/补画/归位循环，UI 退出"绘制中/暂停中"状态并弹窗提示；重新连接后执行「笔回原点」即可恢复位置跟踪
- **归位耗时统计日志**：每次归位输出总耗时与分步耗时（probe/pen/motors/travel/idle/disable），travel 段持续变长可作为机械阻力增大或通信退化的硬件健康参考
- CHANGELOG.md（本文件），记录格式遵循 Keep a Changelog

### Changed

- **归位失败恢复策略**：失败时位置标记为未知（下次操作前强制重新归位）、清空命令队列、兜底关闭电机防止锁轴；服务端通过 WebSocket 广播错误，UI 弹窗提示
- **超时全覆盖**：所有关键 EBB 命令（`executeMotion` / `setPenHeight` / `enableMotors` / `waitUntilMotorsIdle` / `HM` / 行程归位等）均加超时包装（常规命令 15s、长行程 150s），串口异常不再无限挂起
- **Lint 零告警**：清理全部 10 项历史遗留（4 处 `parseInt` 缺 radix、4 处失效的 biome-ignore/eslint-disable 注释、useEffect 多余依赖、CSS 降序特异性），biome 检查 30 文件 0 error / 0 warning / 0 info
- **测试扩充**：vitest 用例 34 个（新增补画后以 `LM` 行程归位、原点安全空操作等集成场景），全部通过

### 升级说明

直接替换旧版目录即可，配置与计划文件无格式变更。若从 v0.17.1 升级，补画后归位将恢复正常工作。

## [0.17.1] - 2026-08-30

### Added

- **SVG transform 完整支持**：支持全部 6 种变换函数（`matrix` / `translate` / `scale` / `rotate` / `skewX` / `skewY`）、任意深度 `<g>` 嵌套复合、基于根 viewBox 用户单位的坐标衔接。矩阵计算与浏览器原生 `getCTM()` 精度一致（1e-9）。含 `transform` 的文件（Affinity Designer、Illustrator 导出）不再需要预先烘焙变换

### Known Issues

- 不支持 `<use>` / `<defs>` 引用间接展开；嵌套 `<svg>` 元素的视口设置按 `<g>` 处理（与更早版本一致）
