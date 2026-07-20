export const runStatuses = [
  'queued',
  'launching',
  'navigating',
  'waiting',
  'capturing',
  'completed',
  'failed',
] as const

export type RunStatus = (typeof runStatuses)[number]

export interface Viewport {
  width: number
  height: number
}

export interface CreateRunRequest {
  url: string
  viewport: Viewport
  deviceScaleFactor: number
  fullPage: boolean
  readySelector: string
}

export interface RunManifest {
  runId: string
  request: CreateRunRequest
  status: RunStatus
  createdAt: string
  updatedAt: string
  completedAt: string | null
  screenshotPath: string | null
  screenshotUrl: string | null
  error: string | null
}

export interface CreateRunResponse {
  run: RunManifest
}

export interface HealthResponse {
  status: 'ok'
  timestamp: string
}

export interface ApiErrorResponse {
  error: string
}

export interface RunEvent {
  type: 'status'
  run: RunManifest
}
