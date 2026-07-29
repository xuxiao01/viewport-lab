import type { RerunScope, ScreenshotDevicePresetSnapshot, ScreenshotPlatformId } from './index.js'

export const agentRunStatuses = [
  'queued',
  'launching',
  'running',
  'awaiting_gateway',
  'executing',
  'capturing',
  'completed',
  'failed',
  'cancelled',
] as const

export type AgentRunStatus = (typeof agentRunStatuses)[number]

export const agentExecutionModes = ['per_device', 'leader_broadcast'] as const

export type AgentExecutionMode = (typeof agentExecutionModes)[number]

export const terminalAgentRunStatuses = new Set<AgentRunStatus>([
  'completed',
  'failed',
  'cancelled',
])

export const agentConfidenceLevels = ['high', 'medium', 'low'] as const

export type AgentConfidenceLevel = (typeof agentConfidenceLevels)[number]

export const agentStepStatuses = ['success', 'failed', 'skipped'] as const

export type AgentStepStatus = (typeof agentStepStatuses)[number]

export interface AgentStepInfo {
  step: string
  intent: string
  observation: string
  confidence: AgentConfidenceLevel
  issues: string[]
}

export const agentWaitStatuses = ['ready', 'timed_out'] as const

export type AgentWaitStatus = (typeof agentWaitStatuses)[number]

export const agentWaitSignalStatuses = ['ready', 'pending', 'skipped', 'error'] as const

export type AgentWaitSignalStatus = (typeof agentWaitSignalStatuses)[number]

export interface AgentWaitSignal {
  status: AgentWaitSignalStatus
  detail: string | null
}

export interface AgentWaitResult {
  status: AgentWaitStatus
  reason: string
  elapsedMs: number
  signals: {
    navigation: AgentWaitSignal
    network: AgentWaitSignal
    dom: AgentWaitSignal
    fonts: AgentWaitSignal
    images: AgentWaitSignal
    paint: AgentWaitSignal
  }
}

export interface AgentPageState {
  url: string
  title: string
}

export interface AgentSnapshotMeta {
  snapshotRef: string | null
  changed: boolean
  truncated: boolean
  originalChars: number
  returnedChars: number
  sameAsStepIndex: number | null
  sha256: string | null
}

export interface DeviceAgentStep {
  stepIndex: number
  command: string
  args: string[]
  purpose: string
  status: AgentStepStatus
  info: AgentStepInfo | null
  output: string | null
  error: string | null
  wait: AgentWaitResult | null
  page: AgentPageState | null
  snapshot: string | null
  snapshotMeta: AgentSnapshotMeta | null
  screenshotUrl: string | null
  locator: string | null
  startedAt: string
  completedAt: string
  durationMs: number
}

export interface DeviceAgentRun {
  deviceId: string
  platformId: ScreenshotPlatformId
  presetId: string
  presetName: string
  cliDeviceName: string
  status: AgentRunStatus
  steps: DeviceAgentStep[]
  finalScreenshotPath: string | null
  finalScreenshotUrl: string | null
  testScriptUrl: string | null
  error: string | null
  summary: AgentStepInfo | null
  durationMs: number | null
}

export interface AgentRun {
  kind: 'agent'
  executionMode: AgentExecutionMode
  leaderDeviceId: string | null
  runId: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  status: AgentRunStatus
  url: string
  task: string
  note: string
  model: string | null
  devices: ScreenshotDevicePresetSnapshot[]
  maxTurns: number
  deviceRuns: DeviceAgentRun[]
  rerunDeviceIds: string[]
  error: string | null
  durationMs: number | null
}

export interface AgentRunSummary {
  kind: 'agent'
  executionMode: AgentExecutionMode
  leaderDeviceId: string | null
  runId: string
  createdAt: string
  completedAt: string | null
  status: AgentRunStatus
  url: string
  task: string
  note: string
  model: string | null
  deviceCount: number
  completedDeviceCount: number
  failedDeviceCount: number
  stepCount: number
  durationMs: number | null
}

export interface CreateAgentRunRequest {
  url: string
  task: string
  note: string
  devices: ScreenshotDevicePresetSnapshot[]
  maxTurns: number
}

export interface CreateAgentRunResponse {
  run: AgentRun
}

export interface RerunAgentRunRequest {
  scope: RerunScope
}

export interface RerunAgentRunResponse {
  run: AgentRun
  selectionIds: string[]
}

export interface UpdateAgentRerunListRequest {
  deviceId: string
  included: boolean
}

export interface UpdateAgentRerunListResponse {
  rerunDeviceIds: string[]
}

export interface ListAgentRunsResponse {
  runs: AgentRunSummary[]
}

export interface GetAgentRunResponse {
  run: AgentRun
}

export interface AgentGatewayStatus {
  configured: boolean
  model: string | null
  vhost: string | null
  reason: string | null
}

export interface RetryScreenshot {
  stepIndex: number
  url: string
}

export interface RetryDeviceResult {
  deviceId: string
  presetName: string
  platformName: string
  specPath: string
  status: 'passed' | 'failed' | 'skipped'
  output: string | null
  durationMs: number | null
  error: string | null
  screenshots: RetryScreenshot[]
}

export interface RetryRun {
  retryId: string
  runId: string
  startedAt: string
  completedAt: string
  status: 'completed' | 'failed'
  deviceResults: RetryDeviceResult[]
  error: string | null
}

export interface RetryRunSummary {
  retryId: string
  runId: string
  startedAt: string
  completedAt: string
  status: 'completed' | 'failed'
  deviceCount: number
  passedCount: number
  failedCount: number
  skippedCount: number
}

export interface ListRetryRunsResponse {
  retries: RetryRunSummary[]
}

export interface GetRetryRunResponse {
  retry: RetryRun
}

export interface CreateRetryRunResponse {
  retry: RetryRun
}

export type AgentEvent =
  | { type: 'status'; run: AgentRun }
  | {
      type: 'device_status'
      runId: string
      deviceId: string
      status: AgentRunStatus
      error: string | null
    }
  | { type: 'device_step'; runId: string; deviceId: string; step: DeviceAgentStep; run: AgentRun }
  | {
      type: 'device_completed'
      runId: string
      deviceId: string
      deviceRun: DeviceAgentRun
      run: AgentRun
    }
  | { type: 'log'; runId: string; message: string; level: 'info' | 'warn' | 'error' }
