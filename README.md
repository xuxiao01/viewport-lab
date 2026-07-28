<p align="center">
  <img src="https://typorabucket0308.oss-cn-beijing.aliyuncs.com/images/20260603103934962.jpg" alt="Viewport Lab 项目预览图" width="800" />
</p>

<h1 align="center">Viewport Lab</h1>

<p align="center">
  本地运行的 H5 多端视口适配与自动截图工具。
</p>

Viewport Lab 用于在一组固定逻辑视口下快速检查 H5 页面的布局表现。用户输入目标 URL 并选择平台和设备预设后，Fastify 服务会通过 Playwright Chromium 并发打开页面、等待就绪并生成真实截图。

项目定位为开发和测试阶段使用的本地内部工具，截图与运行历史直接保存在本机文件系统，不需要数据库。

## 功能特性

- 输入一个 HTTP/HTTPS 页面地址，对选中设备预设执行批量截图。
- 内置苹果手机、苹果平板、安卓手机和安卓平板四类平台，共 17 个逻辑视口。
- 平台和子预设可多选，支持全选、清空和平台 Tab 切换。
- 通过 BrowserContext 设置 viewport、DPR、移动布局和触摸模拟。
- 截图前等待 DOMContentLoaded、网络空闲、字体、可见图片和 DOM 稳定。
- 提供“默认模式”和“额外等待 30 秒”两种截图时机。
- 使用 SSE 推送任务进度，连接异常时前端自动降级为轮询。
- 按平台分组展示截图，支持折叠、大图查看和当前会话失败任务重试。
- 每次批量执行生成独立历史批次，持久化 URL、备注、状态、耗时、预设快照和图片路径。
- 提供历史时间线、批次详情、按原参数重跑和单个历史批次删除。
- 已预留基准批次和对比批次的前端选择能力，当前不执行像素 diff。

## 设备视口

| 平台     | 预设数 | 逻辑视口                                                  |
| -------- | -----: | --------------------------------------------------------- |
| 苹果手机 |      5 | 390×844、393×852、402×874、430×932、440×956               |
| 苹果平板 |      3 | 820×1180、768×1024、810×1080                              |
| 安卓手机 |      3 | 360×800、393×873、420×933                                 |
| 安卓平板 |      6 | 800×1280、640×876、800×1088、800×1164、720×1100、920×1400 |

完整 DPR、屏幕档位和代表机型说明见 [多端视口预设参考](./docs/layouts/viewport-presets-reference.md)。Android 平板的 DPR 为根据采集物理分辨率推算的工程测试值，不代表对应型号的真机实测结果。

## 工作流程

```text
输入 URL 与备注
       ↓
选择平台和逻辑视口
       ↓
创建批次 manifest
       ↓
为每个预设启动 Chromium 截图任务
       ↓
通过 SSE / 轮询更新前端进度
       ↓
保存 PNG 与批次元数据
       ↓
在历史时间线中查看结果
```

## 技术栈

### 前端

- Vue 3.5
- TypeScript
- Vite 7
- Vue Router
- Pinia
- Element Plus
- 原生 CSS 与 CSS Variables

### 后端

- Node.js 22
- TypeScript
- Fastify 5
- Playwright Library
- Chromium
- tsx
- `@fastify/static`

### 工程化

- pnpm workspace
- ESLint 9
- Prettier 3
- vue-tsc
- 前后端共享 TypeScript 接口类型

## 目录结构

```text
viewport-lab/
├── apps/
│   ├── web/                     # Vue 前端应用
│   │   └── src/
│   │       ├── components/      # 截图表单、设备选择、历史与预览
│   │       ├── config/          # 设备视口预设
│   │       ├── stores/          # 批次、SSE 和轮询状态
│   │       └── views/
│   └── server/                  # Fastify + Playwright 截图服务
├── packages/
│   └── shared/                  # 前后端共享接口和状态类型
├── data/
│   └── runs/                    # 本地批次 manifest 和 PNG
├── docs/
│   └── layouts/                 # 视口参数与布局 Agent 交接文档
├── package.json
├── pnpm-workspace.yaml
└── tsconfig.base.json
```

## 环境要求

- Node.js `>= 22.12.0`
- pnpm `10.x`（根目录声明版本为 `10.13.1`）
- Chromium 运行时

仓库的 `.nvmrc` 使用 Node.js `22.14.0`。不强制安装 nvm；如果本机已安装 nvm，可在根目录执行 `nvm use`。

## 本地运行

### 1. 安装依赖

```bash
pnpm install
```

### 2. 准备 Chromium

如果本机还没有 Playwright Chromium，执行：

```bash
pnpm --filter @viewport-lab/server exec playwright install chromium
```

### 3. 可选：创建本地环境变量

不修改默认端口时可以跳过这一步。

```bash
cp .env.example .env
```

### 4. 启动前后端

```bash
pnpm dev
```

默认地址：

- Web：<http://localhost:5188>
- Server：<http://localhost:3001>
- 健康检查：<http://localhost:3001/api/health>

## 第一次截图

1. 启动一个可从截图服务访问的 H5 页面。
2. 打开 <http://localhost:5188>。
3. 输入目标页面的完整 HTTP/HTTPS URL。
4. 可选填写“本次备注”，并选择截图模式。
5. 选择平台和设备视口。默认选中苹果手机的 5 个预设。
6. 点击“开始批量截图”，在进度区查看任务状态。
7. 完成后在截图历史中查看分组图片和批次信息。

### 截图模式

| 模式           | 行为                                       | 适用场景                         |
| -------------- | ------------------------------------------ | -------------------------------- |
| 默认模式       | 页面通过就绪检查后立即截图                 | 普通静态页面或数据返回稳定的页面 |
| 额外等待 30 秒 | 首次就绪后等待 30 秒，然后再做一次就绪检查 | 用于判断是否存在异步渲染时机问题 |

30 秒模式只会延后截图，不会点击页面元素，也不会修复目标页面的接口失败、空数据、登录态或折叠状态。

## 本地数据

每次普通截图或 Agent 探索都会在 `data/runs/{时间ID}` 下建立独立目录：

```text
data/runs/2026-07-21_15-58-33-036_9ced1a4f/
├── manifest.json
├── iphone-390x844.png
├── iphone-393x852.png
└── ...
```

`manifest.json` 保存批次 ID、时间、URL、备注、模式、聚合状态、耗时、设备预设快照、截图路径和错误信息。PNG 图片与 manifest 保存在同一批次目录中。

Agent 批次同样使用时间 ID，设备最终截图保存在批次根目录；逐步截图、页面快照和生成的测试脚本保存在 `agent/{deviceId}` 子目录，并通过“视口截图”页的统一历史查看。

`data/runs/*` 已被 Git 忽略，仓库只保留 `.gitkeep`。在前端删除终态批次时，对应目录与其中的 PNG 会从本地磁盘删除。

## 环境变量

| 变量名               | 默认值                  | 作用                                            |
| -------------------- | ----------------------- | ----------------------------------------------- |
| `SERVER_HOST`        | `127.0.0.1`             | Fastify 监听主机                                |
| `SERVER_PORT`        | `3001`                  | Fastify 监听端口                                |
| `VITE_SERVER_TARGET` | `http://localhost:3001` | Vite 开发服务中 `/api` 和 `/outputs` 的代理目标 |

真实 `.env` 已被 Git 忽略，请不要在仓库中提交本地配置或敏感信息。

## 常用命令

| 命令                | 说明                                   |
| ------------------- | -------------------------------------- |
| `pnpm dev`          | 并行启动 Web 与 Server 开发服务        |
| `pnpm build`        | 构建 workspace 中的前端、后端和共享包  |
| `pnpm typecheck`    | 构建共享声明并执行 TypeScript 类型检查 |
| `pnpm lint`         | 执行 ESLint                            |
| `pnpm format`       | 使用 Prettier 格式化项目               |
| `pnpm format:check` | 检查 Prettier 格式                     |

## API

| 方法     | 路径                              | 作用                           |
| -------- | --------------------------------- | ------------------------------ |
| `GET`    | `/api/health`                     | 服务健康检查                   |
| `POST`   | `/api/batches`                    | 创建批量截图批次及设备快照     |
| `GET`    | `/api/batches`                    | 按时间倒序获取本地批次摘要     |
| `GET`    | `/api/batches/:batchId`           | 获取批次详情                   |
| `DELETE` | `/api/batches/:batchId`           | 删除已结束批次及其本地文件     |
| `POST`   | `/api/runs`                       | 为批次中的一个设备创建截图任务 |
| `GET`    | `/api/runs/:runId`                | 查询单个截图任务               |
| `GET`    | `/api/runs/:runId/events`         | 通过 SSE 接收任务状态          |
| `GET`    | `/outputs/:batchId/:presetId.png` | 访问已生成的 PNG               |

公开请求、响应、批次 manifest 和状态类型位于 `packages/shared`。

## 页面就绪说明

工具会等待通用的浏览器信号，但无法自动理解每个业务页的“真正完成”：

- 目标页面的接口返回错误或空数据时，等待不会修复业务状态。
- 需要登录、App 注入、Cookie 或 localStorage 的页面，在全新 BrowserContext 中可能与手动浏览器不同。
- 只有点击后才展开或请求数据的内容，不会因等待时间增加而自动出现。
- 当页面需要明确的业务就绪信号时，建议在目标 H5 中提供稳定的加载状态和可观测标记。

## 构建与部署

```bash
pnpm build
```

构建产物：

- Web：`apps/web/dist`
- Server：`apps/server/dist`
- Shared：`packages/shared/dist`

可通过以下命令运行已构建的后端：

```bash
pnpm --filter @viewport-lab/server start
```

项目当前没有提供完整的生产部署脚本、前端静态服务或 Nginx 配置，部署方案待补充。该工具可以访问本地和内网页面，并且没有登录与权限系统，不建议直接暴露到公网。

## 当前范围

已实现的第一阶段能力包含 Chromium 批量截图、进度通知、本地历史和设备预设管理。当前明确不包含：

- 视觉基线管理和像素 diff
- 完整设备矩阵管理后台
- 登录、权限和多用户
- 数据库、Redis 和任务队列
- Electron 或 Tauri 桌面应用
- Chromium 以外的浏览器引擎
- 通用的截图前页面交互录制

## 后续计划

- 增加通用的截图前页面操作配置，用于展开折叠区或进入指定业务状态。
- 在现有基准/对比批次选择之上补充可视化对比能力。
- 增加截图任务并发控制，降低大批量 Chromium 实例对本机资源的占用。
- 根据真机验证结果持续校准 Android 设备预设。
- 补充自动化测试和生产部署文档。

## 相关文档

- [多端视口预设参考](./docs/layouts/viewport-presets-reference.md)
- [目标项目布局 Agent 交接说明](./docs/layouts/project-layout-agent-handoff.md)

## License

待补充。
