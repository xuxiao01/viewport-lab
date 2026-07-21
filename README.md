# Viewport Lab

一个本地运行的 H5 多端适配与自动截图工具。前端提交页面地址和视口参数，Fastify 服务使用 Playwright Chromium 截图，并将结果保存到本地。

## 环境要求

- Node.js 22.12.0 或更高版本（仓库 `.nvmrc` 使用 22.14.0）
- pnpm 10.x

## 安装

先确认本机 Node.js 版本：

```bash
node -v
```

版本为 `v22.12.0` 或更高即可，不要求安装 nvm。如果本机已经安装 nvm，可以选择执行 `nvm use`，让当前终端使用 `.nvmrc` 中指定的 Node.js 版本。

然后安装项目依赖：

```bash
pnpm install
```

如果首次截图提示找不到 Chromium，请安装浏览器运行时：

```bash
pnpm --filter @viewport-lab/server exec playwright install chromium
```

复制环境变量示例仅在需要修改默认值时才有必要：

```bash
cp .env.example .env
```

默认前端地址为 `http://localhost:5188`，后端地址为 `http://localhost:3001`。

## 开发

```bash
pnpm dev
```

打开 `http://localhost:5188`，输入目标页面完整 URL，选择需要检查的平台和视口预设，然后点击“开始批量截图”。页面默认选中苹果手机的 5 个逻辑视口，并在截图完成后按平台展示真实结果。
手机和平板预设会同时启用 Chromium 的移动布局与触摸模拟，使页面 viewport 行为与 Chrome DevTools 响应式模式保持一致。

每次点击“开始批量截图”都会在 `data/runs/{batchId}` 创建一个独立批次目录。目录名以本地批次创建时间开头，例如
`2026-07-20_23-18-42-057_a1b2c3d4`：

- `batch.json`：批次标识和创建时间
- `{presetId}.png`：该批次中每个视口预设的截图，例如 `iphone-390x844.png`
- `{runId}.manifest.json`：每个截图任务的请求参数、状态、时间和错误信息

运行记录不会提交到 Git。

## 检查与构建

```bash
pnpm typecheck
pnpm lint
pnpm build
```

构建后可以执行 `pnpm --filter @viewport-lab/server start` 启动后端；前端构建产物位于 `apps/web/dist`。

## API

- `GET /api/health`
- `POST /api/batches`
- `POST /api/runs`
- `GET /api/runs/:runId`
- `GET /api/runs/:runId/events`（SSE）
- `GET /outputs/:batchId/:presetId.png`

任务状态和 SSE 订阅保存在服务进程内，manifest 持久化到磁盘。服务重启后不会恢复未完成任务。前端优先使用 SSE 接收进度，连接失败时自动降级为每秒轮询运行查询接口。

## 当前范围

第一版只支持 Chromium 和单次截图链路，不包含设备矩阵、视觉基线、像素 diff、登录、数据库、任务队列或桌面端封装。
