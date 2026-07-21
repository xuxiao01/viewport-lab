import type { RunManifest, RunStatus, Viewport } from '@viewport-lab/shared'

export type PlatformId = 'ios-phone' | 'ios-tablet' | 'android-phone' | 'android-tablet'

export interface ViewportPreset {
  id: string
  name: string
  description: string
  representativeModels: string[]
  viewport: Viewport
  deviceScaleFactor: number
  isMobile: true
  hasTouch: true
  fullPage: false
  readySelector: ''
}

export type SelectionState = 'checked' | 'indeterminate' | 'unchecked'

export interface PlatformPresetGroup {
  id: PlatformId
  name: string
  shortName: string
  description: string
  presets: ViewportPreset[]
}

export interface CaptureTask {
  id: string
  platformId: PlatformId
  preset: ViewportPreset
  status: RunStatus
  run: RunManifest | null
  error: string | null
}

export type PlatformCaptureStatus = 'waiting' | 'capturing' | 'completed' | 'failed'

export interface PlatformProgressItem {
  platformId: PlatformId
  name: string
  status: PlatformCaptureStatus
  completed: number
  total: number
}
