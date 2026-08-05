import type { AgentModelName } from './agent.js'
import type { CaptureDelayMs, RunKind, ScreenshotDevicePresetSnapshot } from './index.js'

interface TestConfigurationBase {
  configId: string
  name: string
  kind: RunKind
  sourceRunId: string
  createdAt: string
  url: string
  note: string
  devices: ScreenshotDevicePresetSnapshot[]
}

export interface ViewportTestConfiguration extends TestConfigurationBase {
  kind: 'viewport'
  captureDelayMs: CaptureDelayMs
}

export interface AgentTestConfiguration extends TestConfigurationBase {
  kind: 'agent'
  task: string
  maxTurns: number
  model: AgentModelName
}

export type TestConfiguration = ViewportTestConfiguration | AgentTestConfiguration

export interface TestConfigurationSummary {
  configId: string
  name: string
  kind: RunKind
  sourceRunId: string
  createdAt: string
  url: string
  note: string
  task: string | null
  captureDelayMs: CaptureDelayMs | null
  maxTurns: number | null
  deviceCount: number
  deviceNames: string[]
}

export interface SaveTestConfigurationRequest {
  sourceKind: RunKind
  sourceRunId: string
  name: string
}

export interface SaveTestConfigurationResponse {
  configuration: TestConfiguration
  created: boolean
}

export interface ListTestConfigurationsResponse {
  configurations: TestConfigurationSummary[]
}

export interface GetTestConfigurationResponse {
  configuration: TestConfiguration
}
