# Viewport Lab 多模态 Agent 与截图证据报告改造方案

- 日期：2026-07-28
- 状态：最终设计
- 目标项目：`old/viewport-lab`
- 设计范围：Agent Explorer，不改变普通批量截图能力

## 1. 结论

将现有基于 Playwright CLI accessibility snapshot 的文本 Agent 改造成“视觉 + 结构化页面信息”的混合多模态 Agent。

每个设备 Agent 的执行规则如下：

1. 接收必填任务 `task` 和可选预期结果 `expectedResult`。
2. 初始打开页面后保存一张视口截图，并把真实图片内容发送给多模态模型。
3. 此后每个 Agent 轮次都保存视口截图，生成稳定的 `imageRef`，并在下一次模型决策中发送当前图片。
4. accessibility snapshot、动作结果和截图同时作为观察依据；不改成纯视觉坐标 Agent。
5. 全部原始截图构成完整执行轨迹，不因是否入选报告而删除。
6. Agent 结束时必须通过一次成功的 `submit_run_report` 工具调用提交设备报告和精选截图引用。
7. 服务端校验截图引用并持久化设备报告；整个批次报告由服务端确定性汇总，不再调用一个自由发挥的汇总模型。
8. 未填写预期结果时只报告执行情况，不评价是否符合预期；填写后才输出预期符合度。

最终形成两级产物：

```text
完整轨迹：所有步骤、动作结果、snapshot、原始截图
精选报告：执行结论、预期符合度、发现项、有价值截图及解释
```

## 2. 已确认设计决策

### 2.1 输入语义

- `url`：必填，目标页面。
- `task`：必填，Agent 要执行或检查的任务。
- `expectedResult`：可选，用户期望任务完成后满足的状态。
- `note`：可选，仅供人类查看，不进入预期判定。
- `devices`、`maxTurns`：保留现有语义。

示例：

```text
task:
  打开课程列表，进入第一节课程并检查底部操作区域

expectedResult:
  课程内容正常显示，底部“开始学习”按钮完整可见且可以点击
```

### 2.2 两种状态必须分离

Agent 是否完成任务，与页面是否符合预期不是同一件事。

```ts
type ExecutionStatus = 'completed' | 'partial' | 'failed'

type ExpectationStatus =
  | 'satisfied'
  | 'not_satisfied'
  | 'inconclusive'
  | 'not_evaluated'
```

典型情况：Agent 成功完成“检查按钮是否可见”的任务，但发现按钮被遮挡。此时：

```text
executionStatus = completed
expectationStatus = not_satisfied
```

### 2.3 观察与证据分层

- 所有截图都是运行观察 `observation artifact`。
- 只有 Agent 最终引用的截图才是报告证据 `selected evidence`。
- “没有选中截图”不等于“没有截图”，也不等于“没有问题”。
- Agent 只提交引用与解释，不拥有文件复制、移动或删除权限。

### 2.4 设备报告与批次报告分层

- 每个设备 Agent 独立执行并提交一份 `DeviceRunReport`。
- 服务端根据固定规则汇总为 `BatchRunReport`。
- 不使用额外 LLM 对所有设备报告重新总结，避免引入不可审计的新结论。
- 前端同时展示批次总览、设备报告和完整轨迹。

## 3. 目标与非目标

### 3.1 本次目标

- 模型每轮都能看到当前页面截图，而不是只收到本地 URL 字符串。
- 保存完整、不可变、可追溯的截图轨迹。
- 让最终报告引用真实存在的截图并解释其价值。
- 支持无预期的探索任务和有预期的验证任务。
- 控制图片上下文成本，避免轮数增加导致请求体无限膨胀。
- 保留现有 Playwright CLI、安全命令白名单、多设备并行和 spec 生成能力。
- 对模型失败、最大轮数、报告缺失和图片引用错误提供可识别降级。

### 3.2 本次不做

- 不建设视觉基线和像素 diff 平台。
- 不做跨运行长期 Agent 记忆。
- 不上传云对象存储，继续使用本地文件系统。
- 不自动生成视频。
- 不让模型直接执行任意 Playwright/JavaScript 代码；保留现有命令白名单。
- 不把多模态模型的主观判断当成唯一测试 Oracle。
- 不兼容纯文本模型的静默降级；模型不支持视觉时应阻止启动并明确报错。

## 4. 总体架构

```text
AgentView
  -> POST /api/agent/runs
       task + optional expectedResult + devices
  -> Run Coordinator
       -> expectation planner（仅 expectedResult 非空）
       -> parallel Device Agents
            -> Playwright CLI action
            -> Screenshot Capture
            -> Image Registry
            -> Multimodal Context Builder
            -> AI Gateway
            -> run_cli / submit_run_report
       -> Device Report Validator
       -> Deterministic Batch Aggregator
       -> manifest.json + reports/*.json + screenshots/*
  -> SSE events
  -> Live trajectory + final report UI
```

建议新增后端模块：

```text
apps/server/src/agent/
  image-registry.ts          # imageRef、元数据、引用校验
  screenshot-capture.ts      # 页面稳定、截图和模型图片转换
  multimodal-context.ts      # 滚动视觉窗口与历史压缩
  expectation-planner.ts     # 可选预期拆解
  report-validator.ts        # 终止工具 payload 校验
  report-aggregator.ts       # 设备 -> 批次的确定性汇总
```

## 5. 运行状态机

在现有状态基础上增加 `planning`、`compacting` 和 `reporting`：

```text
queued
  -> planning                 # 仅有 expectedResult 时
  -> launching
  -> capturing               # 初始截图
  -> awaiting_gateway
  -> executing
  -> capturing
  -> awaiting_gateway
  -> ...
  -> compacting              # 达到上下文阈值时，可选
  -> reporting               # 接收并校验 submit_run_report
  -> completed | failed | cancelled
```

`AgentRun.status` 仍表示生命周期状态。报告内的 `executionStatus` 和 `expectationStatus` 表示业务结论，不能复用生命周期字段。

## 6. 截图与图片引用设计

### 6.1 每轮截图规则

- 初始页面加载完成后产生 `stepIndex=0` 的截图。
- 每次 `run_cli` 完成后都产生新的步骤截图，包括命令失败、`snapshot` 和 `find`。
- 截图使用当前 viewport，不使用 full-page；它必须反映该设备用户当时真正看到的区域。
- 原始文件使用 PNG，作为审计与报告源文件。
- 发送给模型的图片从原始 PNG 生成 JPEG，最长边默认限制为 1600px、质量默认 82，以控制请求大小。
- 模型图片转换参数与结果 hash 写入元数据，转换文件可以不持久化。
- 即使两轮画面相同，也保留两个步骤级 artifact；后续可用感知 hash 去重物理文件，但不能合并步骤记录。

当前代码使用 `recordedSteps.length + 1` 生成步骤号，失败动作不会增加 `recordedSteps`，可能造成重复 `stepIndex`。改造时必须改为以 Agent turn 单调递增，成功与失败都占一个唯一步骤号。

### 6.2 页面稳定规则

用有上限的稳定检测替换固定 `500ms`：

1. 等待动作对应的 Playwright 完成信号。
2. 等待字体 ready。
3. 等待可见图片完成或失败。
4. 在短窗口内检查 DOM/布局是否稳定。
5. 总等待达到超时后仍截图，但标记 `captureStatus='timed_out'`。

不得无限等待 `networkidle`，业务页可能存在 SSE、轮询或长连接。

### 6.3 ImageArtifact 契约

```ts
interface ImageArtifact {
  imageRef: string
  runId: string
  deviceId: string
  stepIndex: number
  phase: 'initial' | 'after_action' | 'fallback'
  sourceCommand: string
  sourceActionSucceeded: boolean
  url: string
  pageTitle: string | null
  viewport: { width: number; height: number }
  deviceScaleFactor: number
  scroll: { x: number; y: number }
  capturedAt: string
  captureStatus: 'settled' | 'timed_out' | 'failed'
  rawPath: string
  publicUrl: string
  mimeType: 'image/png'
  width: number
  height: number
  sha256: string
  perceptualHash: string | null
  modelTransform: {
    mimeType: 'image/jpeg'
    maxEdge: number
    quality: number
    sha256: string
  } | null
}
```

`imageRef` 是不可变业务 ID，不是文件路径或临时 URL。推荐格式：

```text
img_{stepIndex}_{sha256前8位}
```

唯一性范围为 `(runId, deviceId, imageRef)`。

### 6.4 图片安全

- 最终工具只能引用当前设备 Image Registry 中的 `imageRef`。
- 服务端拒绝跨 run、跨 device、路径字符串和未知引用。
- 模型消息使用内存中的 data URL 或网关支持的上传 ID，不使用仅浏览器可访问的 `/agent-outputs/...` URL。
- 日志禁止写入 base64 图片内容。
- 运行目录仍按现有隐私规则本地保存，不提交 Git。
- 第一版提供可配置的 CSS selector 脱敏遮罩；密码框、token、明显的认证字段默认遮罩。

## 7. 多模态消息协议

### 7.1 初始消息

初始 user 消息包含设备信息、任务、不可变预期、初始 snapshot 摘要、`imageRef` 和图片内容：

```ts
{
  role: 'user',
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        device,
        task,
        expectedResult,
        acceptanceCriteria,
        currentImageRef,
        currentSnapshot,
      }),
    },
    {
      type: 'image_url',
      image_url: {
        url: 'data:image/jpeg;base64,...',
        detail: 'high',
      },
    },
  ],
}
```

### 7.2 动作后消息

为兼容部分 OpenAI 协议实现不允许在 `tool` role 中放图片，采用两条消息：

1. `tool`：只包含动作结果、错误、snapshot 摘要和新 `imageRef`。
2. `user`：包含“这是动作后的当前页面”文本和真实图片 content part。

模型下一次决策必须以这张图片为当前页面，不能把旧图当成现状。

### 7.3 重新定义步骤观察语义

现有 `run_cli.info.observation` 在动作执行前由模型生成，却描述为“执行后观察”，语义不成立。改为描述模型当前已经看到的页面：

```ts
interface CurrentObservation {
  imageRef: string
  summary: string
  issues: string[]
  confidence: 'high' | 'medium' | 'low'
}

interface RunCliDecision {
  observation: CurrentObservation
  command: AllowedCliCommand
  args: string[]
  purpose: string
}
```

这样每张图片在下一轮都会获得模型观察文本，历史图片即使从视觉上下文中移除，仍可通过 `imageRef + observation` 出现在证据账本中。

## 8. 上下文与成本控制

不能把所有历史图片永久追加进 Chat Completions messages。每次请求都会重发历史，图片成本会随轮数快速增长。

采用三层上下文：

### 8.1 完整轨迹层

- 本地保存全部模型消息摘要、工具调用、工具结果、snapshot 和截图元数据。
- 用于调试和审计，不全部发送给模型。

### 8.2 视觉工作窗口

- 当前截图：始终发送。
- 上一张截图：仅在画面发生明显变化、需要 before/after，或上一轮失败时发送。
- 默认最多同时发送 2 张图片。
- 历史图片通过 `imageRef` 和文字观察保留，不再发送像素。

### 8.3 运行摘要层

每 6 轮或请求估算超过阈值时压缩旧消息，保留：

- 已完成动作。
- 尚未完成任务。
- 已发现问题。
- 预期检查项当前证据。
- 图片证据账本：`imageRef -> observation -> related step`。
- 最近两轮完整消息与合法的 tool call/result 配对。

压缩不能覆盖磁盘上的原始轨迹。上下文压缩失败时，保留最近窗口并使用服务端根据结构化步骤生成的确定性摘要。

## 9. 预期结果规划与判定

### 9.1 无预期结果

`expectedResult` 为空时：

```text
expectationStatus = not_evaluated
criteriaResults = []
```

报告只描述实际执行、未完成项和发现，不出现“符合预期”一类措辞。

### 9.2 有预期结果

在启动设备 Agent 前，Coordinator 对 `expectedResult` 做一次文本结构化，产生全批次共享且不可变的检查项：

```ts
interface AcceptanceCriterion {
  criterionId: string
  text: string
  evidenceRequirement: string
}
```

规则：

- 生成 1 至 8 个检查项。
- 不引入用户没有表达的新要求。
- 规划失败时退化为一个检查项，其内容就是完整原始 `expectedResult`。
- 检查项一旦写入 manifest，设备 Agent 不得修改，只能评价。
- 原始 `expectedResult` 始终保留，不能只保存模型拆解结果。

每个设备对检查项输出：

```ts
type CriterionStatus =
  | 'satisfied'
  | 'not_satisfied'
  | 'inconclusive'
  | 'not_applicable'

interface CriterionResult {
  criterionId: string
  status: CriterionStatus
  explanation: string
  evidenceRefs: string[]
}
```

没有可靠截图或结构化页面证据时必须使用 `inconclusive`，不能猜测。

## 10. 终止工具与设备报告

移除现有 `finish`，增加 `submit_run_report`。它是终止工具，不执行浏览器动作。

### 10.1 工具约束

- 一个设备运行只接受一次成功提交。
- Schema 或图片引用非法时，返回工具错误，允许最多两次修正；非法尝试不计为成功提交。
- 成功后立即终止设备 Agent，不再请求模型生成普通文本回复。
- 工具只提交结构化报告和图片引用，不复制或删除图片。
- 精选图片默认最多 8 张/设备。
- 成功完成任务且存在截图时，至少选择一张能表示最终状态的图片。
- 每个 major/critical finding 必须至少引用一张证据；证据不足则 finding confidence 不能为 high。

### 10.2 报告契约

```ts
type FindingSeverity = 'info' | 'minor' | 'major' | 'critical'
type EvidenceKind =
  | 'completion_state'
  | 'visual_issue'
  | 'functional_issue'
  | 'expectation_check'
  | 'before_after'
  | 'cross_viewport'

interface DeviceFinding {
  findingId: string
  title: string
  severity: FindingSeverity
  explanation: string
  expected: string | null
  actual: string
  confidence: 'high' | 'medium' | 'low'
  evidenceRefs: string[]
  relatedStepIndexes: number[]
}

interface SelectedEvidence {
  imageRef: string
  kind: EvidenceKind
  title: string
  explanation: string
  relatedFindingIds: string[]
  relatedStepIndexes: number[]
  pairGroupId: string | null
}

interface DeviceRunReport {
  schemaVersion: 2
  executionStatus: ExecutionStatus
  summary: string
  completedActions: string[]
  incompleteActions: string[]
  expectationStatus: ExpectationStatus
  criteriaResults: CriterionResult[]
  findings: DeviceFinding[]
  selectedEvidence: SelectedEvidence[]
  limitations: string[]
}
```

`pairGroupId` 用于表达 before/after 或同一问题的多图证据。第一版前端按同组连续展示，不做新的复杂组模型。

## 11. 批次报告汇总

服务端在所有设备进入终态后生成：

```ts
interface BatchRunReport {
  schemaVersion: 2
  executionStatus: ExecutionStatus
  expectationStatus: ExpectationStatus
  summary: string
  deviceResults: Array<{
    deviceId: string
    executionStatus: ExecutionStatus
    expectationStatus: ExpectationStatus
    reportPath: string | null
  }>
  criterionSummary: Array<{
    criterionId: string
    status: CriterionStatus
    deviceStatuses: Record<string, CriterionStatus>
  }>
  evidenceCount: number
  findingCounts: Record<FindingSeverity, number>
  limitations: string[]
}
```

确定性汇总规则：

### 11.1 ExecutionStatus

- 任一设备 `failed`：批次 `failed`。
- 否则任一设备 `partial`：批次 `partial`。
- 所有设备 `completed`：批次 `completed`。

### 11.2 ExpectationStatus

- 用户未填写预期：`not_evaluated`。
- 任一适用设备或检查项 `not_satisfied`：`not_satisfied`。
- 所有适用设备和检查项均为 `satisfied`，且至少有一个适用结果：`satisfied`。
- 其他情况：`inconclusive`。

批次 `summary` 使用固定模板生成，例如：

```text
已在 5 个设备视口执行任务：4 个完成，1 个部分完成。
用户预期未满足；2 个设备发现底部按钮被遮挡。
共保留 7 张精选证据，完整轨迹包含 42 张截图。
```

## 12. 异常与降级

### 12.1 达到最大轮数

- 停止浏览器动作。
- 服务端生成 `fallback` 设备报告。
- `executionStatus='partial'`。
- 有预期时 `expectationStatus='inconclusive'`，除非已经存在明确、已提交的否定证据。
- `reportSubmissionStatus='missing'`，不能伪装成 Agent 正常提交。

### 12.2 模型或网关失败

- 保留所有已生成 artifact。
- 生命周期状态设为 `failed`。
- 生成 fallback 报告，说明失败阶段和最后成功步骤。
- 不把内部密钥、完整请求体或 base64 写入错误信息。

### 12.3 截图失败

- 动作轨迹继续记录。
- 当前步骤 `captureStatus='failed'`。
- 如果没有可发送的当前图片，多模态 Agent 最多允许重试截图一次；仍失败则设备运行失败，不静默切换为文本 Agent。

### 12.4 报告引用非法

- 返回具体但不泄露路径的校验错误，例如 `unknown imageRef img_...`。
- 允许模型修正。
- 超过两次后生成 fallback 报告并失败终止。

### 12.5 取消运行

- 不再调用模型补报告。
- 保存当前轨迹，生成 `executionStatus='partial'` 的系统报告。
- 标记 `reportSubmissionStatus='not_requested_due_to_cancellation'`。

## 13. 存储结构

建议 schema v2 目录：

```text
data/agent_runs/{runId}/
  manifest.json
  batch-report.json
  expectation-plan.json
  events.jsonl
  {deviceId}/
    device-report.json
    image-registry.json
    agent.spec.ts
    screenshots/
      000-initial.png
      001-after-click.png
      002-after-snapshot.png
    snapshots/
      000.txt
      001.txt
    transcript/
      messages.jsonl
      context-compactions.jsonl
```

`manifest.json` 增加 `schemaVersion: 2`。读取代码对旧 manifest 使用可选字段和 v1 adapter，历史记录仍可查看；不修改旧运行产物。

## 14. API 与共享类型变更

### 14.1 创建运行

```ts
interface CreateAgentRunRequest {
  url: string
  task: string
  expectedResult: string
  note: string
  devices: ScreenshotDevicePresetSnapshot[]
  maxTurns: number
}
```

`expectedResult` 采用空字符串表示未提供，进入领域层后归一化为 `null`。

### 14.2 Run 对象新增字段

```ts
interface AgentRun {
  schemaVersion: 2
  expectedResult: string | null
  acceptanceCriteria: AcceptanceCriterion[]
  report: BatchRunReport | null
  // existing fields...
}

interface DeviceAgentRun {
  reportSubmissionStatus:
    | 'pending'
    | 'submitted'
    | 'missing'
    | 'invalid'
    | 'fallback_generated'
  report: DeviceRunReport | null
  imageArtifacts: ImageArtifact[]
  // existing fields...
}
```

### 14.3 SSE 新事件

```ts
type AgentEvent =
  | ExistingAgentEvents
  | { type: 'image_captured'; runId: string; deviceId: string; image: ImageArtifact }
  | { type: 'device_report'; runId: string; deviceId: string; report: DeviceRunReport }
  | { type: 'batch_report'; runId: string; report: BatchRunReport }
```

SSE 事件只发送图片元数据和 URL，不发送 base64。

## 15. 网关与模型能力

当前默认模型配置没有声明视觉能力。新增显式配置：

```dotenv
AGENT_GATEWAY_MODEL=<支持图片和工具调用的模型>
AGENT_GATEWAY_VISION_ENABLED=true
AGENT_GATEWAY_IMAGE_DETAIL=high
AGENT_IMAGE_MAX_EDGE=1600
AGENT_IMAGE_JPEG_QUALITY=82
AGENT_VISUAL_HISTORY_SIZE=2
AGENT_CONTEXT_COMPACT_EVERY_TURNS=6
AGENT_SCREENSHOT_SETTLE_TIMEOUT_MS=3000
```

启动运行前检查：

- `VISION_ENABLED` 必须为 true。
- 配置模型必须在项目维护的能力表中标记为 `image_input + tool_calling`。
- 网关状态 API 返回 `supportsVision`、`supportsTools` 和图片限制。
- 首次接入新模型时执行受控 capability smoke test；不要在每个用户运行时探测并产生额外费用。

如果公司网关不支持 `tool` 消息之后追加图片，应由 `MultimodalGatewayAdapter` 调整消息形态，不把供应商差异扩散到 Agent 状态机。

## 16. Prompt 规则

系统 Prompt 增加以下硬约束：

- 当前图片由 `currentImageRef` 标识，只描述实际可见内容。
- 不根据旧图片推断当前页面状态。
- accessibility snapshot 和图片冲突时，报告冲突并降低置信度。
- 不得声称执行未发生的动作。
- `completedActions` 只能来自成功步骤。
- 有预期时逐项评价固定 `acceptanceCriteria`；无证据使用 `inconclusive`。
- 无预期时禁止输出是否符合预期。
- 最终只能通过 `submit_run_report` 结束。
- 精选证据必须说明该图证明什么，不能使用“页面截图”一类无信息描述。
- 不把 loading、动画中间态当成稳定结论，除非超时本身就是问题。
- 不选择大量重复截图；优先最终状态、明确问题、关键转折和前后对比。

## 17. 前端改造

### 17.1 创建表单

在“任务描述”下增加：

```text
预期结果（可选）
例如：课程列表非空，底部按钮完整可见且可以点击
```

网关状态展示：

```text
模型：xxx · 图片输入：支持 · 工具调用：支持
```

任一必要能力不支持时禁用启动按钮并显示原因。

### 17.2 当前运行

- 继续显示设备、步骤、最新截图和全部截图。
- 每个步骤显示 `imageRef`、capture status 和 Agent 对该图片的观察。
- 不展示模型内部 thinking。
- `reporting` 阶段显示“正在整理报告”，不显示成浏览器仍在操作。

### 17.3 最终报告

运行结束后在完整轨迹之前展示：

1. 执行状态。
2. 有预期时展示预期符合度；无预期时完全隐藏该区块。
3. 已完成与未完成事项。
4. 检查项及各设备结果。
5. 发现项、严重度和证据。
6. 精选截图画廊，每张展示解释、设备、步骤和 capture status。
7. 限制与证据不足说明。

完整步骤截图保留在可折叠轨迹区，不能被精选报告替代。

## 18. 可重跑脚本

保留现有 `agent.spec.ts` 生成。改造时同步修正：

- 只把成功动作写入脚本。
- 截图文件名使用真实 `stepIndex`，不重新连续编号导致与原轨迹错位。
- 在脚本中保留任务和预期结果注释。
- 第一版不把 LLM 的视觉判断自动翻译成 Playwright assertion；避免生成不稳定断言。
- 后续可以把明确 criterion 转换为人工可审阅的 TODO assertion，此项延期。

## 19. 测试方案

### 19.1 单元测试

- 每个成功或失败动作生成唯一单调 `stepIndex`。
- Image Registry 拒绝跨 run、跨 device 和未知 `imageRef`。
- 图片转换不改变原始 PNG，且记录正确 hash。
- 多模态 context 中始终包含当前图片，最多包含配置数量的历史图片。
- 压缩后保留最近合法 tool call/result 配对。
- `submit_run_report` schema、枚举、数量限制和引用关系校验。
- 无预期时强制 `not_evaluated` 和空 criteria。
- 批次 execution/expectation 汇总真值表。
- 最大轮数、取消、网关失败和报告缺失的 fallback 报告。
- v1 manifest 仍可读取。

### 19.2 集成测试

使用假的 OpenAI-compatible server 验证完整序列：

```text
initial image message
  -> run_cli tool call
  -> textual tool result
  -> current image message
  -> submit_run_report tool call
  -> persisted device report
```

覆盖：

- 图片 content part 实际存在，不只是 URL 文本。
- 工具调用与图片消息顺序正确。
- 非法报告允许修正。
- 视觉能力关闭时创建运行失败。
- 多设备并行时图片和报告不串设备。
- SSE 只发送元数据，不泄露 base64。

### 19.3 E2E 固定页面

建立本地确定性 fixture：

- 正常完成页。
- 移动端按钮溢出页。
- 异步加载和动画页。
- modal 遮挡页。
- canvas 控件页。
- 动作失败但页面仍可截图页。
- 两个视口表现不同的响应式页面。

### 19.4 受控真实模型评测

至少记录：

- 任务完成率。
- 预期判断准确率。
- 精选证据 precision：所选图片是否真正支持解释。
- 证据覆盖率：明确 finding 是否有支持图片。
- 非法 imageRef 率。
- 重复精选截图率。
- 平均每轮图片字节数、prompt tokens、延迟和总成本。
- 文本 Agent 与多模态 Agent 的配对对比结果。

## 20. 实施阶段

### Phase 0：网关验证

- 确认一个同时支持图片输入和 function calling 的公司网关模型。
- 用一张无敏感内容的固定图片验证 Chat Completions 消息格式。
- 确认 tool result 后追加 user image message 的兼容性。
- 固化模型能力表和错误响应。

完成标准：真实模型可以看到图片、正确调用 `run_cli`，并最终调用结构化报告工具。

### Phase 1：契约和 artifact 层

- 扩展 shared 类型和 schemaVersion。
- 新增 Image Registry、截图元数据和稳定 imageRef。
- 修复 stepIndex 重复风险。
- 增加 expectedResult 输入和存储。
- 保持旧 manifest 可读。

完成标准：不接模型也能生成完整、可校验的逐轮图片轨迹。

### Phase 2：多模态 Agent 循环

- 增加图片转换和 multimodal content parts。
- 重构 `llm-client.ts` 的消息构造。
- 每轮截图都反馈给模型。
- 引入滚动视觉窗口和结构化运行摘要。
- 重定义 observation 语义。

完成标准：模型每轮依据最新图片决策，请求体不会随轮数无限增长。

### Phase 3：报告与证据

- 增加 expectation planner。
- 用 `submit_run_report` 替换 `finish`。
- 实现引用校验、fallback 报告和批次聚合。
- 写入 device-report.json 与 batch-report.json。

完成标准：每个正常设备运行恰好有一份成功提交报告，所有精选截图引用均可解析。

### Phase 4：前端

- 增加可选预期输入。
- 展示视觉模型能力。
- 展示运行报告、检查项、finding 和精选证据。
- 保留完整轨迹与重跑页面。

完成标准：用户无需查看原始 manifest 即可理解执行情况、预期结论和截图依据。

### Phase 5：评测和加固

- 增加固定 E2E 页面与真实模型小样本评测。
- 调整图片尺寸、质量、视觉窗口和最大证据数。
- 增加隐私遮罩、成本指标和错误可观测性。

完成标准：达到约定的准确率和成本阈值后再扩大设备并发。

## 21. 验收标准

功能验收：

- 每个设备初始页面和每个 Agent 轮次都有独立截图 artifact。
- 除截图失败外，模型每次决策都收到最新真实图片内容。
- 模型仍能使用 snapshot/ref 和生成 locator。
- 正常结束必须成功提交一次设备报告。
- 精选图片全部能在 Image Registry 中找到并属于当前设备。
- 所有原始截图仍可从完整轨迹查看。
- 用户不填预期时没有预期判定。
- 用户填写预期时报告逐项给出状态、解释和证据。
- 多设备批次报告严格按确定性规则汇总。
- 最大轮数、网关失败、取消和报告非法都有明确降级状态。

工程验收：

- `pnpm build`、`pnpm typecheck`、`pnpm lint` 通过。
- 新增单元与集成测试通过。
- 不把 base64、密钥或敏感截图内容写入日志。
- v1 历史运行仍能打开。
- 多模态请求大小、调用耗时和 usage 可观测。

## 22. 从开源项目吸收的思路

- Midscene：完整执行历史与最终可消费报告分离，截图和结构化 JSON 都可导出。
- Hercules：proofs 与测试步骤、报告、截图等运行产物绑定。
- agent-qa：历史信息只是辅助上下文，当前页面和实时证据优先；记忆与 action cache 分离。
- Webwright：浏览器会话可丢弃，可重跑代码和本地 artifact 才是长期产物。
- Lumen：视觉工作窗口、历史压缩、终止验证和会话安全策略。

本方案没有直接引入这些框架；保留现有 Playwright CLI 和多设备编排，只吸收其可审计轨迹、视觉上下文控制和证据分层思想。

## 23. 被拒绝与延期方案

### Rejected

- 纯视觉 Agent：失去 accessibility tree、语义 locator 和稳定脚本生成能力。
- 把所有历史图片永久发给模型：成本和延迟不可控。
- 只保存最终精选截图：失去调试和审计轨迹。
- 让最终工具接收任意文件路径：存在幻觉引用和路径安全风险。
- 使用第二个自由总结 Agent 生成批次结论：可能篡改或夸大设备报告。
- 无预期时仍输出 passed/failed：把执行成功误当成页面符合未知要求。
- 视觉模型不可用时静默退化为文本：结果质量发生不可见变化。

### Deferred

- 视觉基线、像素 diff 和基线审批：完成本次证据链后单独设计。
- 跨运行长期记忆和自愈缓存：积累稳定运行数据后再引入。
- Agent 自动生成视觉断言代码：先验证视觉判断准确率。
- 对截图自动裁剪、框选和标注：第一版保存 region 元数据的扩展空间，暂不修改原图。
- 云存储、分享权限和团队协作：本地工具阶段不需要。
- 视频回放：完整截图轨迹已经满足第一阶段复盘需要。

## 24. 最终决策树状态

### Confirmed

- 输入：任务必填，预期结果可选。
- 输出：始终有执行报告；有预期才评价符合度。
- 感知：视觉截图与 accessibility snapshot 混合。
- 截图：每轮保存，完整轨迹与精选证据分层。
- 终止：一次成功的 `submit_run_report` 工具调用。
- 汇总：设备 Agent 独立报告，服务端确定性汇总批次。
- 上下文：当前图必传，视觉历史滚动窗口默认 2。
- 失败：不静默降级，保留 artifact 并生成明确 fallback 报告。

### Rejected

- 纯视觉、无限图片历史、任意路径引用、无预期强判定、额外自由汇总模型。

### Deferred

- 像素 diff、长期记忆、视觉断言生成、图片自动标注、云端分享、视频回放。

### Open

- 无。实施前只需通过 Phase 0 确认具体网关视觉模型和消息兼容性；这属于环境验证，不改变总体设计。
