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

export const batchStatuses = ['queued', 'running', 'completed', 'partial_failed', 'failed'] as const

export type BatchStatus = (typeof batchStatuses)[number]

export const screenshotPlatformIds = [
  'ios-phone',
  'ios-tablet',
  'android-phone',
  'android-tablet',
] as const

export type ScreenshotPlatformId = (typeof screenshotPlatformIds)[number]

export const batchNoteMaxLength = 200

export const captureDelayValues = [0, 30_000] as const

export type CaptureDelayMs = (typeof captureDelayValues)[number]

export const screenshotLimits = {
  viewport: { min: 1, max: 10_000 },
  deviceScaleFactor: { min: 0.1, max: 4 },
} as const

export interface Viewport {
  width: number
  height: number
}

export interface CreateRunRequest {
  batchId: string
  selectionId: string
  outputName: string
  url: string
  viewport: Viewport
  deviceScaleFactor: number
  isMobile: boolean
  hasTouch: boolean
  fullPage: boolean
  readySelector: string
  captureDelayMs: CaptureDelayMs
}

export interface ScreenshotDevicePresetSnapshot {
  selectionId: string
  platformId: ScreenshotPlatformId
  platformName: string
  presetId: string
  presetName: string
  viewport: Viewport
  deviceScaleFactor: number
  isMobile: boolean
  hasTouch: boolean
  fullPage: boolean
  readySelector: string
  captureDelayMs: CaptureDelayMs
}

export interface ScreenshotDeviceRun extends ScreenshotDevicePresetSnapshot {
  runId: string | null
  status: RunStatus
  createdAt: string
  updatedAt: string
  completedAt: string | null
  screenshotPath: string | null
  screenshotUrl: string | null
  error: string | null
}

export interface CreateBatchRequest {
  url: string
  note: string
  captureDelayMs: CaptureDelayMs
  devices: ScreenshotDevicePresetSnapshot[]
}

export interface BatchManifest {
  batchId: string
  createdAt: string
  updatedAt: string
  completedAt: string | null
  url: string
  note: string
  captureDelayMs: CaptureDelayMs
  status: BatchStatus
  durationMs: number | null
  deviceCount: number
  successCount: number
  failedCount: number
  devices: ScreenshotDeviceRun[]
}

export interface BatchSummary {
  batchId: string
  createdAt: string
  completedAt: string | null
  url: string
  note: string
  captureDelayMs: CaptureDelayMs
  status: BatchStatus
  durationMs: number | null
  deviceCount: number
  successCount: number
  failedCount: number
}

export interface CreateBatchResponse {
  batch: BatchManifest
}

export interface ListBatchesResponse {
  batches: BatchSummary[]
}

export interface ScreenshotComparisonSelection {
  baselineBatchId: string | null
  comparisonBatchId: string | null
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
