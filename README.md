# Bit2AtomBot

> 基于 Web 的 AxiDraw 笔式绘图仪控制系统

---

## 📋 项目定位

Bit2AtomBot 是一款专为 **AxiDraw 系列笔式绘图仪**设计的现代化 Web 控制端。它提供了更直观的操作界面、更丰富的硬件适配能力和更流畅的用户体验。

![image-20260624231750551](https://github.com/lymanzhang/Bit2AtomPlotWebUI/blob/main/docs/image-20260625225937219.png)

### 旧版

![image-20260625225937219](https://github.com/lymanzhang/Bit2AtomPlotWebUI/blob/main/docs/image-20260624231750551.png)

# **AxiDraw控制程序**

项目将绘图仪的控制从传统的桌面端（Inkscape 插件）解放出来，通过浏览器即可完成从 SVG 加载、路径预览、参数调整到设备驱动的全流程操作。

---

## 功能特性

### 核心绘图功能

- **SVG 拖放加载** — 拖入或粘贴 SVG 文件，自动解析并展平路径
- **实时路径预览** — 在纸张模拟区域内预览绘制路径，支持按绘制顺序着色
- **网格与标尺** — 绘制区域以 5mm/10mm 浅色方格打底，四周带刻度标尺，便于观察坐标
- **隐藏线去除** — 自动裁剪填充图形（如圆形、矩形）后方的线条，模拟真实遮挡效果
- **完整运动规划** — 恒加速度梯形/三角形速度曲线，拐角速度优化
- **路径优化** — 路径排序（最小化抬笔空跑）、路径合并、短路径过滤、去重点
- **图层控制** — 按 stroke 颜色或 group ID 自动分层，可选择特定图层绘制
- **缩放适配** — 自动缩放并居中适配纸张，或手动裁剪至边距
- **清除 SVG** — 预览区域右上角一键清除当前加载的 SVG 文件，方便更换文件
- **SVG 导出** — 将经过路径优化和隐藏线去除后的结果导出为 SVG 文件（仅含落笔绘制路径）

### 传动参数（高级功能）

- **自定义硬件配置** — 支持用户创建并保存命名硬件配置
- **步进电机参数**：
  - 步距角（°）：支持 1.8°、0.9° 等
  - 驱动细分：16、32、64 等
  - 同步轮齿数：20、18、16 等
  - 同步带齿距（mm）：2（GT2）等
- **实时计算** — 自动计算 `stepsPerMm` 和 `微步值`
- **预设硬件**：AxiDraw V3 / Brushless / NextDraw 2234 / iDraw H SE

### 交互相应

- **全中文界面** — 所有操作面板完全中文化
- **实时进度跟踪** — 绘制进度条 + 百分比显示
- **预计时长与剩余时间** — 自动估算绘制时间
- **总路径统计** — 实时显示走笔总路程
- **暂停/继续/取消** — 绘制和模拟过程中可随时控制
- **硬件选择** — 未连接设备时也可随时调整硬件型号或创建自定义配置（下拉框始终启用）
- **暗色模式** — 在「更多设置」中切换浅色/暗色主题，持久化偏好设置

### 设备驱动

- **双模式架构**：
  - **服务端模式**（默认）：Express + WebSocket + NodeSerialPort
  - **WebSerial 模式**：浏览器直接控制（`IS_WEB=1`）
- **多硬件支持**：AxiDraw V3 / Brushless / NextDraw 2234 / iDraw H SE
- **EBB 固件自适应**：自动检测固件版本，选择 LM（低层恒加速）或 XM（高层匀速）指令

### 模拟绘制

- **无需硬件** — 未连接设备时也可用
- **真实速度** — 按照实际运动规划的速度曲线逐动作推进
- **进度可视化** — 十字准星沿路径实时移动，进度条同步更新百分比
- **随时停止** — 模拟过程中可点击「停止模拟」结束

### AI 集成

- **SVG.io API** 集成 — 通过文本提示词直接生成可绘制的 SVG 图像
- 支持扁平、轮廓、剪影、单线、线条艺术等多种风格

---

## 独特性与价值

### 对比传统方案

| 维度     | Inkscape + AxiDraw 插件   | Bit2AtomBot                          |
| -------- | ------------------------- | ------------------------------------ |
| 依赖     | 需安装 Inkscape + X11     | 只需浏览器 + Node.js                 |
| 启动速度 | 慢（Inkscape 启动耗时长） | 极快（毫秒级启动）                   |
| 远程控制 | 需 VNC/RDP                | 浏览器直接访问                       |
| 自动化   | 不支持                    | 支持 CLI 批处理                      |
| 运动规划 | 基础                      | 恒加速度 + 拐角优化                  |
| 硬件兼容 | 单一硬件                  | 多预设 + 自定义硬件                  |
| 参数可调 | 有限                      | 全参数可调（加速度/速度/转弯系数等） |
| AI 生成  | 不支持                    | 内置 SVG.io API                      |
| 平台兼容 | Linux/macOS 优先          | Windows/macOS/Linux                  |

### 核心价值

1. **无需桌面软件** — 浏览器即控制台，树莓派 Zero 也能流畅运行
2. **远程操控** — 局域网内任何设备（手机/平板/笔记本）均可控制
3. **低门槛** — 拖入 SVG 点击绘制，3 步完成
4. **硬件灵活** — 支持自定义传动参数，适配不同步进电机与同步带配置
5. **自动化友好** — 命令行批处理模式，可集成到自动化流水线
6. **开源透明** — AGPL-3.0 协议，可自由审查和修改

---

## 运行环境

### 硬件要求

- 任意 AxiDraw 系列绘图仪（V3 / Brushless / NextDraw 2234 / iDraw H SE）
- 或兼容 EBB 固件的绘图仪

### 软件要求

| 依赖    | 版本要求                | 说明              |
| ------- | ----------------------- | ----------------- |
| Node.js | >= 20.0.0               | JavaScript 运行时 |
| npm     | >= 9.x                  | 包管理器          |
| 浏览器  | Chrome / Edge / Firefox | 任意现代浏览器    |

### 支持平台

- ✅ Windows 10/11
- ✅ macOS
- ✅ Linux（含树莓派全系列）

---

## 启动方法

### 首次运行

```bash
# 1. 进入项目目录
cd Bit2AtomPlotWebUI/saxi-main

# 2. 安装依赖
npm install

# 3. 完整构建（服务器 + 前端）
npm run build:server
npm run build:ui

# 4. 启动服务
node cli.mjs
```

### 日常启动

```bash
# 方式一：全流程（lint → 构建 → 启动）
npm start

# 方式二：快速启动（跳过构建，代码无变化时使用）
node cli.mjs
```

### 启动后

浏览器打开 **http://localhost:9080**

### 常用命令

| 命令                   | 说明                   |
| ---------------------- | ---------------------- |
| `npm start`            | 完整构建 + 启动        |
| `node cli.mjs`         | 直接启动（不重新构建） |
| `npm run build:server` | 仅编译服务器端         |
| `npm run build:ui`     | 仅编译前端 UI          |
| `npm run build`        | 构建服务器 + 前端      |

### 端口冲突处理

```bash
# 杀掉所有 Node 进程后重启
taskkill /f /im node.exe
node cli.mjs
```

---

## 项目结构

```
saxi-main/
├── tools/
│   ├── safe-edit.ps1              # PowerShell UTF-8 安全编辑函数
│   └── file-edit.py               # Python UTF-8 安全编辑工具
├── test-hidden-line.svg            # 隐藏线去除测试文件
├── cli.mjs                  # CLI 入口
├── build.mjs                # 前端构建脚本
├── package.json             # 项目配置
├── tsconfig*.json           # TypeScript 配置
├── biome.json               # 代码检查配置
├── src/
│   ├── ui.tsx               # React UI 组件（主界面）
│   ├── server.ts            # Express 服务器
│   ├── cli.ts               # CLI 参数解析
│   ├── ebb.ts               # EBB 电机控制协议
│   ├── planning.ts          # 运动规划内核
│   ├── massager.ts          # 路径预处理
│   ├── drivers.ts           # 驱动抽象层
│   ├── util.ts              # 工具函数
│   ├── vec.ts               # 2D 向量运算
│   ├── paper-size.ts        # 纸张尺寸定义
│   ├── style.css            # 界面样式
│   ├── index.html           # HTML 模板
│   └── icons/               # SVG 图标
├── dist/
│   ├── server/              # 编译后的服务器端
│   └── ui/                  # 编译后的前端
└── docs/                    # 原始文档
```

---

## 高级用法

### 自定义硬件配置

1. 在「笔」面板的硬件下拉中选择「── 新建自定义 ──」
2. 配置传动参数：
   - 步距角（°）：步进电机每步转角（常见 1.8° 或 0.9°）
   - 细分：驱动器微步设置（常见 16）
   - 同步轮齿数：皮带轮齿数（常见 20）
   - 齿距（mm）：同步带齿距（GT2 为 2mm）
3. 填写设备名称，点击「保存配置」
4. 配置将持久化到浏览器本地存储，后续可在下拉中直接选用

### 命令行批处理绘制

```bash
# 直接绘制 SVG 文件（不启动 Web 服务器）
node cli.mjs plot input.svg --paper-size A4 --margin 15
```

### AI 图像生成（需 API Key）

```bash
node cli.mjs --svgio-api-key YOUR_API_KEY
```

### WebSerial 模式（纯浏览器控制）

```bash
cross-env IS_WEB=1 npm run build:ui
```

---

## 📄 许可证

AGPL-3.0-only

---

## 致谢

- [saxi](https://github.com/alexrudd2/saxi) — 本项目的基础框架
- [axi](https://github.com/fogleman/axi) — 运动规划算法启发
- [Evil Mad Scientist](https://www.evilmadscientist.com/) — AxiDraw 绘图仪设计者
