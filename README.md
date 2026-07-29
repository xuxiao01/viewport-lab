<p align="center">
  <img src="https://typorabucket0308.oss-cn-beijing.aliyuncs.com/images/20260603103934962.jpg" alt="Viewport Lab 项目预览图" width="800" />
</p>

<h1 align="center">Viewport Lab</h1>

<p align="center">
  面向 H5 页面适配检查的多设备视口截图与 AI 自动探索工具。
</p>

Viewport Lab 是一个本地运行的全栈工具，用于在多种手机、平板逻辑视口下检查 H5 页面表现。它既可以直接批量截图，也可以让 Agent 根据自然语言任务操作页面，并保存最终截图和逐步执行记录。

项目主要面向开发、测试和页面联调场景。运行数据保存在本地文件系统，不依赖数据库。

## 功能特性

- 使用同一个“创建检测任务”面板创建普通截图或 Agent 探索任务。
- AI 任务描述为空时执行普通批量截图；填写后自动切换为 Agent 探索。
- 内置苹果手机、苹果平板、安卓手机和安卓平板四类平台，共 17 个设备视口。
- 支持平台、设备预设多选，并保存视口、DPR、移动端和触摸属性快照。
- 普通截图提供默认模式和额外等待 30 秒模式。
- Agent 支持 1～100 最大轮数设置：主设备完成探索后，会在同一页面会话中切换各逻辑视口保存最终图。
- Agent 通过兼容 OpenAI 协议的 AI 网关生成 Playwright CLI 操作。
- Agent 结果保存最终截图，并支持查看每一步的命令、目的、状态、输出和截图。
- 普通截图和 Agent 统一进入截图历史，按时间展示运行状态和设备结果。
- 支持在原批次内全部重跑、仅重跑失败设备；Agent 还支持人工重跑清单。
- 失败范围重跑只更新参与重跑的设备，不修改已完成设备的图片和步骤。
- 可将终态批次保存为独立配置快照，在配置清单中查看、删除或快速重跑。
- 创建任务表单使用 `localStorage` 自动保存，刷新页面后恢复最近一次配置。
- 使用 SSE 推送任务进度；普通截图连接异常时可降级为轮询。
- 截图与 Agent 运行统一归档到 `data/runs`，配置快照存放在 `data/configurations`。
- Agent 由首台主设备进行模型决策与页面操作；完成后复用同一页面状态，依次切换其他逻辑视口保存最终截图。
- 每步操作后分别等待 URL、加载、网络、DOM、字体、可见图片与连续渲染帧稳定，并保存 accessibility 快照和截图。
- Agent 快照通过 SHA-256 去重，模型侧单次上下文最多保留 40,000 字符。

## 运行模式

### 视口截图

AI 任务描述为空时，系统按照选中的设备参数直接打开目标页面，并在页面达到通用就绪条件后截图。

| 截图模式       | 行为                                     | 适用场景                     |
| -------------- | ---------------------------------------- | ---------------------------- |
| 默认模式       | 页面完成通用就绪检查后立即截图           | 静态页面或数据加载稳定的页面 |
| 额外等待 30 秒 | 首次就绪后额外等待 30 秒，再次检查后截图 | 存在延迟数据或动画的页面     |

### Agent 探索

填写 AI 任务描述后，首台设备作为主设备进行模型决策并完成页面操作。任务结束后，系统在同一浏览器会话中依次切换各设备的逻辑宽高，保存最终截图。

Agent 的操作由模型动态规划，结果仍会受到页面状态、网络、弹窗和登录态影响。任务描述应明确写出目标页面、必要步骤、最终状态和停止条件；从设备单步失败会保留 warning 与证据，并继续接收后续操作。

## 设备视口

| 平台     | 预设数 | 逻辑视口                                                  |
| -------- | -----: | --------------------------------------------------------- |
| 苹果手机 |      5 | 390×844、393×852、402×874、430×932、440×956               |
| 苹果平板 |      3 | 820×1180、768×1024、810×1080                              |
| 安卓手机 |      3 | 360×800、393×873、420×933                                 |
| 安卓平板 |      6 | 800×1280、640×876、800×1088、800×1164、720×1100、920×1400 |

完整 DPR、屏幕档位和代表机型说明见 [多端视口预设参考](./docs/layouts/viewport-presets-reference.md)。

## 技术栈

### 前端

- Vue 3
- TypeScript
- Vite
- Vue Router
- Pinia
- Element Plus
- CSS Variables

### 服务端

- Node.js 22
- TypeScript
- Fastify 5
- Playwright / Playwright CLI
- OpenAI JavaScript SDK
- `@fastify/static`

### 工程化

- pnpm workspace
- ESLint
- Prettier
- vue-tsc
- 前后端共享 TypeScript 类型

## 目录结构

```text
viewport-lab/
├── apps/
│   ├── web/                         # Vue 前端
│   │   └── src/
│   │       ├── components/          # 创建面板、历史、截图和步骤查看器
│   │       ├── config/              # 设备视口预设
│   │       ├── stores/              # 截图、Agent 和配置清单状态
│   │       ├── utils/               # 创建任务草稿持久化
│   │       └── views/               # 首页与配置清单
│   └── server/
│       └── src/
│           ├── agent/               # Agent、网关、记录器和 Playwright CLI
│           ├── index.ts             # Fastify 与普通截图接口
│           └── test-configurations.ts
├── packages/
│   └── shared/                      # 前后端共享类型
├── data/
│   ├── runs/                        # 普通截图和 Agent 运行归档
│   └── configurations/              # 测试配置快照
├── docs/
│   └── layouts/                     # 视口与布局说明
├── .env.example
├── package.json
└── pnpm-workspace.yaml
```

## 环境要求

- Node.js `>= 22.12.0`
- pnpm `10.x`，根目录声明版本为 `10.13.1`
- Playwright Chromium
- Agent 模式需要可访问的兼容 OpenAI 协议的 AI 网关

仓库提供 `.nvmrc`，使用 Node.js `22.14.0`。

## 本地运行

### 1. 安装依赖

```bash
pnpm install
```

### 2. 安装 Chromium

```bash
pnpm --filter @viewport-lab/server exec playwright install chromium
```

### 3. 创建本地环境变量

```bash
cp .env.example .env
```

普通截图可以不配置 AI 网关；使用 Agent 探索前需要补充对应的网关变量。

### 4. 启动项目

```bash
pnpm dev
```

默认地址：

- Web：<http://localhost:5188>
- Server：<http://localhost:3001>
- 健康检查：<http://localhost:3001/api/health>

Vite 使用 `0.0.0.0` 监听，因此启动日志可能同时显示 localhost 和多个本机网卡地址。这些地址只是同一个开发服务的不同访问入口，不代表自动部署到了其他服务器。

## 环境变量

| 变量名                     | 默认值                  | 说明                                  |
| -------------------------- | ----------------------- | ------------------------------------- |
| `SERVER_HOST`              | `127.0.0.1`             | Fastify 监听地址                      |
| `SERVER_PORT`              | `3001`                  | Fastify 监听端口                      |
| `VITE_SERVER_TARGET`       | `http://localhost:3001` | Vite 中 `/api`、`/outputs` 的代理目标 |
| `AGENT_GATEWAY_API_URL`    | 无                      | AI 网关的 OpenAI 兼容 API 地址        |
| `AGENT_GATEWAY_API_KEY`    | 无                      | AI 网关分配的内部 API Key             |
| `AGENT_GATEWAY_VHOST`      | 空字符串                | 网关租户隔离使用的 Virtual Host       |
| `AGENT_GATEWAY_MODEL`      | `deepseek-v4-flash`     | Agent 使用的模型名称                  |
| `AGENT_GATEWAY_TIMEOUT_MS` | `120000`                | 单次模型请求超时时间，单位毫秒        |

`.env` 已被 Git 忽略。不要将 API Key 或其他凭证写入 README、代码、运行 manifest 或配置清单。

## 使用方法

### 创建检测任务

1. 打开 <http://localhost:5188>。
2. 输入目标页面完整 URL。
3. 可选填写任务标题或备注。
4. 如需 Agent 操作页面，填写 AI 任务描述并设置最大轮数；留空则执行普通截图。
5. 选择平台和设备视口。
6. 点击“开始批量截图”或“开始 AI 探索”。
7. 在统一截图历史中查看实时状态和最终结果。

### 重跑批次

普通截图和 Agent 都在原批次内重跑，不会创建新的历史记录。

- 全部重跑：重新执行当前批次的全部设备。
- 重跑失败：只清理并执行最终状态为失败的设备。
- 重跑重跑清单：Agent 专用，只执行人工加入重跑清单的设备。

未参与局部重跑的设备最终图片保持不变。Agent 重跑会用原主设备重新建立模型执行上下文并更新主设备步骤，再只替换本次目标视口的最终截图。

### 配置清单

终态批次可以通过“加入配置清单”保存为独立快照。配置包含 URL、备注、设备参数，以及普通截图模式或 Agent 任务与最大轮数。

配置清单支持：

- 查看：跳转到来源批次查看截图；来源批次删除后不可查看。
- 删除：只删除配置，不影响来源批次。
- 重跑：根据配置快照创建并自动执行新任务；即使来源批次已删除仍可使用。

## 本地数据

普通截图和 Agent 统一使用时间 ID：

```text
data/runs/{YYYY-MM-DD_HH-mm-ss-SSS_随机ID}/
├── manifest.json
├── events.jsonl
├── ios-phone-iphone-390x844.png
└── agent/
    └── ios-phone-iphone-390x844/
        ├── steps/
        │   ├── 00.png
        │   └── 01.png
        ├── snapshots/
        │   └── 00.txt
        └── agent.spec.ts
```

- 普通截图的 PNG 保存在批次根目录。
- Agent 的设备最终截图保存在批次根目录。
- Agent 的逐步截图、页面快照和测试脚本保存在 `agent/{deviceId}`。
- Agent 以请求的第一台设备为主设备：模型只读取并操作主设备页面；任务完成后，系统在同一页面会话中切换其他设备的逻辑宽高并截图。
- 每台设备独立完成页面就绪等待、快照和截图。完整快照写入 `snapshots/`，相同快照使用哈希复用；超过 40,000 字符的模型侧快照会标记截断。
- 配置快照独立保存到 `data/configurations/{配置ID}.json`。
- API Key、VHost 等网关凭证不会写入运行归档。

`data/runs` 和 `data/configurations` 已被 Git 忽略。删除批次会删除对应运行目录；删除配置不会删除批次。

## 常用命令

| 命令                                       | 说明                                   |
| ------------------------------------------ | -------------------------------------- |
| `pnpm dev`                                 | 构建共享包并同时启动 Web 与 Server     |
| `pnpm build`                               | 构建全部 workspace 包                  |
| `pnpm typecheck`                           | 构建共享声明并执行 TypeScript 类型检查 |
| `pnpm lint`                                | 执行 ESLint                            |
| `pnpm --filter @viewport-lab/server test`  | 执行 Agent 协调器测试                  |
| `pnpm format`                              | 使用 Prettier 格式化项目               |
| `pnpm format:check`                        | 检查 Prettier 格式                     |
| `pnpm --filter @viewport-lab/server start` | 运行已构建的服务端                     |

## API 概览

### 普通截图

| 方法     | 路径                          | 作用                         |
| -------- | ----------------------------- | ---------------------------- |
| `GET`    | `/api/health`                 | 服务健康检查                 |
| `POST`   | `/api/batches`                | 创建普通截图批次             |
| `GET`    | `/api/batches`                | 获取普通截图批次列表         |
| `GET`    | `/api/batches/:batchId`       | 获取普通截图批次详情         |
| `POST`   | `/api/batches/:batchId/rerun` | 在原批次内重跑全部或失败设备 |
| `DELETE` | `/api/batches/:batchId`       | 删除终态批次和本地文件       |
| `POST`   | `/api/runs`                   | 创建单个设备截图任务         |
| `GET`    | `/api/runs/:runId`            | 获取单设备任务状态           |
| `GET`    | `/api/runs/:runId/events`     | 订阅单设备 SSE 事件          |

### Agent

| 方法     | 路径                                | 作用                      |
| -------- | ----------------------------------- | ------------------------- |
| `GET`    | `/api/agent/gateway-status`         | 获取 Agent 网关配置状态   |
| `POST`   | `/api/agent/runs`                   | 创建 Agent 批次           |
| `GET`    | `/api/agent/runs`                   | 获取 Agent 批次列表       |
| `GET`    | `/api/agent/runs/:runId`            | 获取 Agent 批次详情       |
| `GET`    | `/api/agent/runs/:runId/events`     | 订阅 Agent SSE 事件       |
| `PUT`    | `/api/agent/runs/:runId/rerun-list` | 加入或移出人工重跑清单    |
| `POST`   | `/api/agent/runs/:runId/rerun`      | 在原批次内按范围重跑      |
| `DELETE` | `/api/agent/runs/:runId`            | 删除 Agent 批次和本地文件 |

### 配置清单

| 方法     | 路径                                 | 作用                   |
| -------- | ------------------------------------ | ---------------------- |
| `GET`    | `/api/test-configurations`           | 获取配置清单           |
| `POST`   | `/api/test-configurations`           | 从终态批次保存配置快照 |
| `GET`    | `/api/test-configurations/:configId` | 获取完整配置           |
| `DELETE` | `/api/test-configurations/:configId` | 删除配置               |

静态截图通过 `/outputs/{runId}/...` 访问。公开请求、响应和 manifest 类型位于 `packages/shared`。

## 构建与部署

```bash
pnpm build
```

构建产物：

- Web：`apps/web/dist`
- Server：`apps/server/dist`
- Shared：`packages/shared/dist`

服务端构建后可以执行：

```bash
pnpm --filter @viewport-lab/server start
```

项目暂未提供完整的生产部署脚本、前端静态资源托管、进程守护或 Nginx 配置。该工具可以访问本地和内网页面，并且没有登录和权限系统，不建议直接暴露到公网。

## 当前限制

- 仅使用 Chromium，不包含 Firefox、WebKit 和真机截图。
- 截图对比目前只保留批次选择界面，尚未实现像素 diff。
- Agent 的页面理解和停止时机依赖模型判断，复杂任务可能出现执行漂移或达到最大轮数。
- Agent 不继承手动浏览器的登录态，依赖 Cookie、App 注入或本地存储的页面可能表现不同。
- 项目没有数据库、分布式任务队列、多用户权限和生产部署方案。

## 后续计划

- 完善 Agent 任务完成判断，达到最大轮数但未调用 `finish` 时明确标记失败。
- 增加 Agent 任务范围约束，减少完成目标后的额外页面操作。
- 在现有批次选择基础上实现可视化截图对比。
- 补充自动化测试、运行监控和生产部署文档。
- 根据真机验证结果持续校准设备预设。

## 相关文档

- [多端视口预设参考](./docs/layouts/viewport-presets-reference.md)
- [项目布局与 Agent 交接说明](./docs/layouts/project-layout-agent-handoff.md)

## License

待补充。
