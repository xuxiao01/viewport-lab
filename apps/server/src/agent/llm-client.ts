import type {
  AgentBlockedModalState,
  AgentFileUploadState,
  AgentPageState,
  AgentNativeDialogState,
  AgentSnapshotMeta,
  AgentStepInfo,
  AgentWaitResult,
  ScreenshotDevicePresetSnapshot,
} from '@viewport-lab/shared'
import OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions.js'

import type { AgentGatewayConfig } from './config.js'
import { createGatewayOpenAIClient } from './gateway-client.js'
import { buildContinuePrompt, buildTaskPrompt, SYSTEM_PROMPT, TOOL_DEFINITIONS } from './prompts.js'

const RECENT_CONVERSATION_ROUNDS = 10
const HISTORY_SUMMARY_LIMIT = 12_000
const HISTORY_SUMMARY_MARKER = '[Agent 历史执行摘要｜系统自动生成]'

interface CompactedHistoryEntry {
  sequence: number
  command: string
  args: string[]
  purpose: string
  observation: string
  issues: string[]
  ok: boolean
  error: string | null
  page: AgentPageState | null
  snapshotRef: string | null
  snapshotSha256: string | null
  consecutiveFailureCount: number
  dialog: AgentNativeDialogState | null
  blockedModal: AgentBlockedModalState | null
  fileUpload: AgentFileUploadState | null
}

export interface NextActionResult {
  command: string | null
  args: string[]
  purpose: string
  info: AgentStepInfo | null
  done: boolean
  summary: AgentStepInfo | null
}

export interface ActionResultReport {
  ok: boolean
  error: string | null
  command: string
  output: string
  wait: AgentWaitResult | null
  page: AgentPageState | null
  snapshot: string | null
  snapshotMeta: AgentSnapshotMeta | null
  screenshotUrl: string | null
  dialog: AgentNativeDialogState | null
  blockedModal: AgentBlockedModalState | null
  fileUpload: AgentFileUploadState | null
}

export interface DeviceLlmClient {
  nextAction(): Promise<NextActionResult>
  retryNextAction(): Promise<NextActionResult>
  reportResult(report: ActionResultReport): void
  close(): void
}

export interface GatewayErrorClassification {
  retryable: boolean
  retryAfterMs: number | null
}

export class AgentGatewayRequestError extends Error {
  readonly status: number | null
  readonly code: string | null
  readonly retryAfterMs: number | null

  constructor(error: unknown) {
    const source = asErrorRecord(error)
    const message = error instanceof Error ? error.message : String(error)
    super(`AI 网关调用失败：${message}`)
    this.name = 'AgentGatewayRequestError'
    this.status = typeof source?.status === 'number' ? source.status : parseStatus(message)
    this.code = typeof source?.code === 'string' ? source.code : null
    this.retryAfterMs = readRetryAfterMs(source?.headers)
  }
}

export function classifyGatewayError(error: unknown): GatewayErrorClassification {
  const message = error instanceof Error ? error.message : String(error)
  const source = asErrorRecord(error)
  const status =
    error instanceof AgentGatewayRequestError
      ? error.status
      : typeof source?.status === 'number'
        ? source.status
        : parseStatus(message)
  const retryAfterMs =
    error instanceof AgentGatewayRequestError ? error.retryAfterMs : readRetryAfterMs(source?.headers)

  if (
    /exceeded (?:your )?current quota|billing details|insufficient[_ -]?quota|token[-_ ]?limit|quota (?:exhausted|exceeded)/i.test(
      message,
    )
  ) {
    return { retryable: false, retryAfterMs: null }
  }
  const transient =
    /too many requests|rate.?limit|\bqps\b|throttl|temporar(?:y|ily)|timeout|timed out|network|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ETIMEDOUT/i.test(
      message,
    ) || (status !== null && status >= 500 && status <= 599)
  return { retryable: transient, retryAfterMs: transient ? retryAfterMs : null }
}

export function createDeviceLlmClient(
  config: AgentGatewayConfig | null,
  device: ScreenshotDevicePresetSnapshot,
  initialUrl: string,
  initialSnapshot: string,
  task: string,
): DeviceLlmClient {
  if (!config) {
    return new StubDeviceLlmClient(device, initialUrl)
  }
  return new RealDeviceLlmClient(config, device, initialUrl, initialSnapshot, task)
}

export class RealDeviceLlmClient implements DeviceLlmClient {
  private readonly client: OpenAI
  private readonly messages: ChatCompletionMessageParam[] = []
  private pendingToolCallId: string | null = null
  private readonly model: string
  private pendingRequestMessages: ChatCompletionMessageParam[] | null = null
  private readonly compactedHistory: CompactedHistoryEntry[] = []
  private compactedRoundCount = 0

  constructor(
    config: AgentGatewayConfig,
    device: ScreenshotDevicePresetSnapshot,
    initialUrl: string,
    initialSnapshot: string,
    task: string,
    client?: OpenAI,
  ) {
    // Device Agent owns retry classification. Disable SDK retries so quota errors are sent once.
    this.client = client ?? createGatewayOpenAIClient(config, 0)
    this.model = config.model

    const deviceLabel = `${device.platformName} ${device.presetName} (${device.viewport.width}×${device.viewport.height})`

    this.messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildTaskPrompt(deviceLabel, task, initialUrl, initialSnapshot) },
    ]
  }

  async nextAction(): Promise<NextActionResult> {
    this.messages.push({
      role: 'user',
      content: buildContinuePrompt(),
    })
    this.pendingRequestMessages = [...this.messages]
    return this.requestPendingAction()
  }

  async retryNextAction(): Promise<NextActionResult> {
    if (!this.pendingRequestMessages) {
      throw new Error('当前没有可重试的模型请求')
    }
    return this.requestPendingAction()
  }

  private async requestPendingAction(): Promise<NextActionResult> {
    const requestMessages = this.pendingRequestMessages
    if (!requestMessages) throw new Error('模型请求上下文未准备')
    let completion: ChatCompletion
    try {
      const result = await this.client.chat.completions.create({
        model: this.model,
        messages: requestMessages,
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
        temperature: 0,
        stream: false,
        enable_thinking: false,
      } as Parameters<typeof this.client.chat.completions.create>[0])
      completion = result as ChatCompletion
    } catch (error) {
      throw new AgentGatewayRequestError(error)
    }

    this.pendingRequestMessages = null

    const choices = completion.choices
    if (!choices || choices.length === 0) {
      return { command: null, args: [], purpose: '', info: null, done: true, summary: null }
    }
    const msg = choices[0]?.message
    if (!msg) {
      return { command: null, args: [], purpose: '', info: null, done: true, summary: null }
    }

    this.messages.push(msg as ChatCompletionMessageParam)

    const toolCalls = msg.tool_calls
    if (toolCalls && toolCalls.length > 0) {
      const toolCall = toolCalls[0]
      if (!toolCall) {
        return { command: null, args: [], purpose: '', info: null, done: true, summary: null }
      }
      this.pendingToolCallId = toolCall.id
      return this.parseToolCall(
        toolCall as { id: string; function: { name: string; arguments: string } },
      )
    }

    const content = msg.content ?? ''
    return {
      command: null,
      args: [],
      purpose: '',
      info: null,
      done: true,
      summary: {
        step: 'text-response',
        intent: '模型返回文本回复，未调用工具',
        observation: content.slice(0, 500),
        confidence: 'low',
        issues: ['模型未调用 finish 工具，直接返回文本'],
      },
    }
  }

  reportResult(report: ActionResultReport): void {
    if (!this.pendingToolCallId) return
    this.messages.push({
      role: 'tool',
      tool_call_id: this.pendingToolCallId,
      content: JSON.stringify({
        ok: report.ok,
        error: report.error,
        command: report.command,
        output: report.output,
        wait: report.wait,
        page: report.page,
        snapshot: report.snapshot,
        snapshotMeta: report.snapshotMeta,
        screenshotUrl: report.screenshotUrl,
        dialog: report.dialog,
        blockedModal: report.blockedModal,
        fileUpload: report.fileUpload,
      }),
    })
    this.pendingToolCallId = null
    this.compactCompletedRounds()
  }

  close(): void {
    // OpenAI SDK 在 Node 端无需显式关闭
  }

  private parseToolCall(toolCall: {
    id: string
    function: { name: string; arguments: string }
  }): NextActionResult {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
    } catch {
      return {
        command: null,
        args: [],
        purpose: '',
        info: {
          step: 'parse-error',
          intent: '解析工具调用参数失败',
          observation: toolCall.function.arguments,
          confidence: 'low',
          issues: ['LLM 返回的工具调用参数不是合法 JSON'],
        },
        done: true,
        summary: null,
      }
    }

    if (toolCall.function.name === 'finish') {
      const summary = parsed.summary as AgentStepInfo | undefined
      return {
        command: null,
        args: [],
        purpose: '',
        info: null,
        done: true,
        summary: summary ?? {
          step: 'finish',
          intent: '任务完成',
          observation: String(parsed.summary ?? ''),
          confidence: 'low',
          issues: [],
        },
      }
    }

    if (toolCall.function.name !== 'run_cli') {
      return {
        command: null,
        args: [],
        purpose: '',
        info: {
          step: 'unknown-tool',
          intent: `未知工具：${toolCall.function.name}`,
          observation: '',
          confidence: 'low',
          issues: [`LLM 调用了未知工具 ${toolCall.function.name}`],
        },
        done: true,
        summary: null,
      }
    }

    const command = typeof parsed.command === 'string' ? parsed.command : null
    const args = Array.isArray(parsed.args) ? (parsed.args as string[]).map(String) : []
    const purpose = typeof parsed.purpose === 'string' ? parsed.purpose : ''
    const info = (parsed.info as AgentStepInfo | undefined) ?? null

    if (!command) {
      return {
        command: null,
        args: [],
        purpose: '',
        info: {
          step: 'invalid-action',
          intent: '无效的命令请求',
          observation: JSON.stringify(parsed),
          confidence: 'low',
          issues: ['LLM 未返回有效的 command'],
        },
        done: true,
        summary: null,
      }
    }

    return { command, args, purpose, info, done: false, summary: null }
  }

  private compactCompletedRounds(): void {
    const summaryIndex = isHistorySummaryMessage(this.messages[2]) ? 2 : -1
    const roundsStart = summaryIndex === -1 ? 2 : 3
    const completedRoundCount = Math.floor((this.messages.length - roundsStart) / 3)
    const roundsToCompact = completedRoundCount - RECENT_CONVERSATION_ROUNDS
    if (roundsToCompact <= 0) return

    const removed = this.messages.splice(roundsStart, roundsToCompact * 3)
    for (let index = 0; index < removed.length; index += 3) {
      const assistantMessage = removed[index + 1]
      const toolMessage = removed[index + 2]
      this.compactedRoundCount += 1
      const entry = compactHistoryEntry(this.compactedRoundCount, assistantMessage, toolMessage)
      const previousEntry = this.compactedHistory.at(-1)
      if (
        !entry.ok &&
        previousEntry &&
        !previousEntry.ok &&
        previousEntry.command === entry.command &&
        previousEntry.error === entry.error
      ) {
        entry.consecutiveFailureCount = previousEntry.consecutiveFailureCount + 1
      }
      this.compactedHistory.push(entry)
    }

    const summaryMessage: ChatCompletionMessageParam = {
      role: 'user',
      content: formatHistorySummary(this.compactedHistory, this.compactedRoundCount),
    }
    if (summaryIndex === -1) this.messages.splice(2, 0, summaryMessage)
    else this.messages[summaryIndex] = summaryMessage
  }
}

class StubDeviceLlmClient implements DeviceLlmClient {
  private turnCount = 0

  constructor(
    private readonly device: ScreenshotDevicePresetSnapshot,
    private readonly initialUrl: string,
  ) {}

  async nextAction(): Promise<NextActionResult> {
    this.turnCount++
    if (this.turnCount === 1) {
      return {
        command: 'goto',
        args: [this.initialUrl],
        purpose: '打开目标页面',
        info: {
          step: 'goto',
          intent: '打开目标页面',
          observation: '页面已加载',
          confidence: 'low',
          issues: ['网关未配置，stub 模式'],
        },
        done: false,
        summary: null,
      }
    }
    return {
      command: null,
      args: [],
      purpose: '',
      info: null,
      done: true,
      summary: {
        step: 'stub-complete',
        intent: 'stub 完成示例任务',
        observation: '网关未配置，仅验证 CLI 管线',
        confidence: 'low',
        issues: ['LLM 网关未配置'],
      },
    }
  }

  async retryNextAction(): Promise<NextActionResult> {
    return this.nextAction()
  }

  reportResult(): void {
    // no-op
  }

  close(): void {
    // no-op
  }
}

function asErrorRecord(error: unknown): Record<string, unknown> | null {
  return typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : null
}

function parseStatus(message: string): number | null {
  const match = message.match(/(?:^|\D)([45]\d\d)(?:\D|$)/)
  return match?.[1] ? Number(match[1]) : null
}

function readRetryAfterMs(headers: unknown): number | null {
  let value: string | null = null
  if (headers instanceof Headers) value = headers.get('retry-after')
  else if (typeof headers === 'object' && headers !== null) {
    const record = headers as Record<string, unknown>
    const raw = record['retry-after'] ?? record['Retry-After']
    if (typeof raw === 'string' || typeof raw === 'number') value = String(raw)
  }
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null
}

function isHistorySummaryMessage(
  message: ChatCompletionMessageParam | undefined,
): boolean {
  return (
    message?.role === 'user' &&
    typeof message.content === 'string' &&
    message.content.startsWith(HISTORY_SUMMARY_MARKER)
  )
}

function compactHistoryEntry(
  sequence: number,
  assistantMessage: ChatCompletionMessageParam | undefined,
  toolMessage: ChatCompletionMessageParam | undefined,
): CompactedHistoryEntry {
  const action = readAssistantAction(assistantMessage)
  const result = readToolResult(toolMessage)
  return {
    sequence,
    command: result.command || action.command || 'unknown',
    args: action.args,
    purpose: action.purpose,
    observation: action.info?.observation ?? '',
    issues: action.info?.issues ?? [],
    ok: result.ok,
    error: result.error,
    page: result.page,
    snapshotRef: result.snapshotMeta?.snapshotRef ?? null,
    snapshotSha256: result.snapshotMeta?.sha256 ?? null,
    consecutiveFailureCount: result.ok ? 0 : 1,
    dialog: result.dialog,
    blockedModal: result.blockedModal,
    fileUpload: result.fileUpload,
  }
}

function readAssistantAction(message: ChatCompletionMessageParam | undefined): {
  command: string
  args: string[]
  purpose: string
  info: AgentStepInfo | null
} {
  if (message?.role !== 'assistant' || !('tool_calls' in message)) {
    return { command: '', args: [], purpose: '', info: null }
  }
  const toolCall = message.tool_calls?.[0]
  if (!toolCall || toolCall.type !== 'function') {
    return { command: '', args: [], purpose: '', info: null }
  }
  try {
    const parsed = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
    return {
      command: typeof parsed.command === 'string' ? parsed.command : toolCall.function.name,
      args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
      purpose: typeof parsed.purpose === 'string' ? parsed.purpose : '',
      info: isAgentStepInfo(parsed.info) ? parsed.info : null,
    }
  } catch {
    return { command: toolCall.function.name, args: [], purpose: '', info: null }
  }
}

function readToolResult(message: ChatCompletionMessageParam | undefined): ActionResultReport {
  const fallback = emptyActionResultReport()
  if (message?.role !== 'tool' || typeof message.content !== 'string') return fallback
  try {
    const parsed = JSON.parse(message.content) as Partial<ActionResultReport>
    return {
      ...fallback,
      ...parsed,
      ok: parsed.ok === true,
      command: typeof parsed.command === 'string' ? parsed.command : '',
      error: typeof parsed.error === 'string' ? parsed.error : null,
      page: isPageState(parsed.page) ? parsed.page : null,
      snapshotMeta: parsed.snapshotMeta ?? null,
      dialog: parsed.dialog ?? null,
      blockedModal: parsed.blockedModal ?? null,
      fileUpload: parsed.fileUpload ?? null,
    }
  } catch {
    return fallback
  }
}

function emptyActionResultReport(): ActionResultReport {
  return {
    ok: false,
    error: null,
    command: '',
    output: '',
    wait: null,
    page: null,
    snapshot: null,
    snapshotMeta: null,
    screenshotUrl: null,
    dialog: null,
    blockedModal: null,
    fileUpload: null,
  }
}

function formatHistorySummary(
  entries: CompactedHistoryEntry[],
  totalRoundCount: number,
): string {
  const successCount = entries.filter((entry) => entry.ok).length
  const failedCount = entries.length - successCount
  const latestPage = [...entries].reverse().find((entry) => entry.page)?.page ?? null
  const header = [
    HISTORY_SUMMARY_MARKER,
    `已压缩 ${totalRoundCount} 个完整轮次：成功 ${successCount}，失败 ${failedCount}。`,
    latestPage
      ? `最近已知页面：${truncateText(latestPage.title || '无标题', 100)} · ${truncateText(latestPage.url, 240)}`
      : '最近已知页面：暂无。',
    '以下是早期轮次的确定性执行记录；旧 snapshot 全文已移除，仅保留页面状态、关键选择和结果。',
  ]
  const rendered = entries.map((entry) => ({
    priority: historyEntryPriority(entry),
    line: formatHistoryEntry(entry),
  }))
  const kept = [...rendered]
  let omitted = 0

  while (summaryLength(header, kept, omitted) > HISTORY_SUMMARY_LIMIT && kept.length > 1) {
    const lowestPriority = Math.min(...kept.map((entry) => entry.priority))
    const removalIndex = kept.findIndex((entry) => entry.priority === lowestPriority)
    kept.splice(removalIndex, 1)
    omitted += 1
  }

  const lines = [
    ...header,
    ...(omitted > 0 ? [`已省略 ${omitted} 条较早的普通成功操作。`] : []),
    '历史步骤：',
    ...kept.map((entry) => entry.line),
  ]
  return truncateText(lines.join('\n'), HISTORY_SUMMARY_LIMIT)
}

function summaryLength(
  header: string[],
  entries: Array<{ line: string }>,
  omitted: number,
): number {
  return (
    header.join('\n').length +
    entries.reduce((total, entry) => total + entry.line.length + 1, 0) +
    (omitted > 0 ? 40 : 0)
  )
}

function formatHistoryEntry(entry: CompactedHistoryEntry): string {
  const details: string[] = []
  if (entry.args.length > 0) details.push(`参数=${truncateText(entry.args.join(' · '), 180)}`)
  if (entry.purpose) details.push(`目的=${truncateText(entry.purpose, 160)}`)
  if (entry.observation) details.push(`观察=${truncateText(entry.observation, 220)}`)
  if (entry.page) {
    details.push(
      `页面=${truncateText(entry.page.title || '无标题', 80)} ${truncateText(entry.page.url, 180)}`,
    )
  }
  if (entry.issues.length > 0) details.push(`问题=${truncateText(entry.issues.join('；'), 220)}`)
  if (entry.error) details.push(`错误=${truncateText(entry.error, 220)}`)
  if (entry.consecutiveFailureCount > 1) {
    details.push(`相同失败连续尝试=${entry.consecutiveFailureCount}次`)
  }
  if (entry.dialog) {
    details.push(
      `原生弹窗=${entry.dialog.type}/${entry.dialog.status}/${entry.dialog.action ?? '未处理'}`,
    )
  }
  if (entry.blockedModal) details.push(`阻断模态=${entry.blockedModal.type}`)
  if (entry.fileUpload) {
    details.push(`文件上传=${entry.fileUpload.fileName}/${entry.fileUpload.status}`)
  }
  if (entry.snapshotRef) details.push(`snapshotRef=${truncateText(entry.snapshotRef, 100)}`)
  if (entry.snapshotSha256) details.push(`snapshotSha256=${entry.snapshotSha256}`)
  const detailText = details.length > 0 ? `；${details.join('；')}` : ''
  return `#${entry.sequence} ${entry.ok ? '成功' : '失败'} ${entry.command}${detailText}`
}

function historyEntryPriority(entry: CompactedHistoryEntry): number {
  if (
    !entry.ok ||
    entry.issues.length > 0 ||
    entry.dialog !== null ||
    entry.blockedModal !== null ||
    entry.fileUpload !== null
  ) {
    return 2
  }
  if (
    ['goto', 'go-back', 'go-forward', 'reload', 'fill', 'select', 'check', 'uncheck'].includes(
      entry.command,
    )
  ) {
    return 1
  }
  return 0
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`
}

function isAgentStepInfo(value: unknown): value is AgentStepInfo {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.step === 'string' &&
    typeof record.intent === 'string' &&
    typeof record.observation === 'string' &&
    Array.isArray(record.issues)
  )
}

function isPageState(value: unknown): value is AgentPageState {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.url === 'string' && typeof record.title === 'string'
}
