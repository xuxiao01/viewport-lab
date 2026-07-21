import type { PlatformId, PlatformPresetGroup } from '../types/capture'

export const viewportPresets: PlatformPresetGroup[] = [
  {
    id: 'ios-phone',
    name: '苹果手机',
    shortName: 'iOS',
    description: 'iPhone 视口预设',
    presets: [
      {
        id: 'iphone-390x844',
        name: '390 × 844',
        description: '经典 6.1 英寸 iPhone',
        representativeModels: [
          'iPhone 12',
          'iPhone 12 Pro',
          'iPhone 13',
          'iPhone 13 Pro',
          'iPhone 14',
        ],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        fullPage: false,
        readySelector: '',
      },
      {
        id: 'iphone-393x852',
        name: '393 × 852',
        description: '主流 6.1 英寸 iPhone',
        representativeModels: ['iPhone 14 Pro', 'iPhone 15', 'iPhone 15 Pro', 'iPhone 16'],
        viewport: { width: 393, height: 852 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        fullPage: false,
        readySelector: '',
      },
      {
        id: 'iphone-402x874',
        name: '402 × 874',
        description: '6.3 英寸 iPhone',
        representativeModels: ['iPhone 16 Pro', 'iPhone 17', 'iPhone 17 Pro'],
        viewport: { width: 402, height: 874 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        fullPage: false,
        readySelector: '',
      },
      {
        id: 'iphone-430x932',
        name: '430 × 932',
        description: '6.7 英寸大屏 iPhone',
        representativeModels: [
          'iPhone 14 Pro Max',
          'iPhone 15 Plus',
          'iPhone 15 Pro Max',
          'iPhone 16 Plus',
        ],
        viewport: { width: 430, height: 932 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        fullPage: false,
        readySelector: '',
      },
      {
        id: 'iphone-440x956',
        name: '440 × 956',
        description: '6.9 英寸 Pro Max',
        representativeModels: ['iPhone 16 Pro Max', 'iPhone 17 Pro Max'],
        viewport: { width: 440, height: 956 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        fullPage: false,
        readySelector: '',
      },
    ],
  },
  {
    id: 'ios-tablet',
    name: '苹果平板',
    shortName: 'iPadOS',
    description: 'iPad 视口预设',
    presets: [
      {
        id: 'ipad-placeholder',
        name: '820 × 1180',
        description: '苹果平板视口占位预设',
        representativeModels: [],
        viewport: { width: 820, height: 1180 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        fullPage: false,
        readySelector: '',
      },
    ],
  },
  {
    id: 'android-phone',
    name: '安卓手机',
    shortName: 'Android',
    description: 'Android 手机视口预设',
    presets: [
      {
        id: 'android-phone-placeholder',
        name: '360 × 800',
        description: '安卓手机视口占位预设',
        representativeModels: [],
        viewport: { width: 360, height: 800 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
        fullPage: false,
        readySelector: '',
      },
    ],
  },
  {
    id: 'android-tablet',
    name: '安卓平板',
    shortName: 'Android',
    description: 'Android 平板视口预设',
    presets: [
      {
        id: 'android-tablet-placeholder',
        name: '800 × 1280',
        description: '安卓平板视口占位预设',
        representativeModels: [],
        viewport: { width: 800, height: 1280 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
        fullPage: false,
        readySelector: '',
      },
    ],
  },
]

export function getPresetSelectionId(platformId: PlatformId, presetId: string): string {
  return `${platformId}:${presetId}`
}

export function getPlatformPresetIds(platform: PlatformPresetGroup): string[] {
  return platform.presets.map((preset) => getPresetSelectionId(platform.id, preset.id))
}

const defaultApplePhonePlatform = viewportPresets.find((platform) => platform.id === 'ios-phone')

export const defaultSelectedPresetIds = defaultApplePhonePlatform
  ? getPlatformPresetIds(defaultApplePhonePlatform)
  : []
