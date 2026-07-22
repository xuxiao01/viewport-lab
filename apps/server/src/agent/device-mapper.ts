import type { ScreenshotDevicePresetSnapshot } from '@viewport-lab/shared'

export interface DeviceMapping {
  cliDeviceName: string
  needsResize: boolean
}

interface PresetMapping {
  presetId: string
  cliDeviceName: string
  needsResize: boolean
}

const PRESET_MAP: PresetMapping[] = [
  { presetId: 'iphone-390x844', cliDeviceName: 'iPhone 12', needsResize: true },
  { presetId: 'iphone-393x852', cliDeviceName: 'iPhone 14 Pro', needsResize: true },
  { presetId: 'iphone-402x874', cliDeviceName: 'iPhone 16 Pro', needsResize: true },
  { presetId: 'iphone-430x932', cliDeviceName: 'iPhone 14 Pro Max', needsResize: true },
  { presetId: 'iphone-440x956', cliDeviceName: 'iPhone 16 Pro Max', needsResize: true },
  { presetId: 'ipad-820x1180', cliDeviceName: 'iPad (gen 7)', needsResize: true },
  { presetId: 'ipad-768x1024', cliDeviceName: 'iPad (gen 5)', needsResize: false },
  { presetId: 'ipad-810x1080', cliDeviceName: 'iPad (gen 7)', needsResize: false },
  { presetId: 'android-phone-360x800', cliDeviceName: 'Galaxy Note 3', needsResize: true },
  { presetId: 'android-phone-393x873', cliDeviceName: 'Pixel 3', needsResize: true },
  { presetId: 'android-phone-420x933', cliDeviceName: 'Pixel 9 Pro', needsResize: true },
  { presetId: 'android-tablet-800x1280', cliDeviceName: 'Nexus 10', needsResize: false },
  { presetId: 'android-tablet-640x876', cliDeviceName: 'Galaxy Tab S9', needsResize: true },
  { presetId: 'android-tablet-800x1088', cliDeviceName: 'Nexus 10', needsResize: true },
  { presetId: 'android-tablet-800x1164', cliDeviceName: 'Nexus 10', needsResize: true },
  { presetId: 'android-tablet-720x1100', cliDeviceName: 'Galaxy Tab S4', needsResize: true },
  { presetId: 'android-tablet-920x1400', cliDeviceName: 'Galaxy Z Fold 6', needsResize: true },
]

const presetMapByPresetId = new Map(PRESET_MAP.map((m) => [m.presetId, m]))

export function mapToDevice(preset: ScreenshotDevicePresetSnapshot): DeviceMapping {
  const found = presetMapByPresetId.get(preset.presetId)
  if (found) {
    return { cliDeviceName: found.cliDeviceName, needsResize: found.needsResize }
  }
  return { cliDeviceName: 'Pixel 7', needsResize: true }
}
