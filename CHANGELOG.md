# 更新日志（Changelog）

本项目所有值得关注的变更都记录在此文件中。

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **运行日志落盘**：服务端每次启动自动将日志写入 `logs/bit2atombot-<日期>-<时间>.log`，每行带本地时间戳与级别（INFO/WARN/ERROR），包含绘制/补画耗时、归位分步耗时、通信探活等性能数据，便于事后分析评估；自动保留最近 50 个文件。`BIT2ATOM_LOG_DIR` 可自定义目录，`BIT2ATOM_NO_FILE_LOG=1` 可禁用

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
