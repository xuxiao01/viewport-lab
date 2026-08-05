import assert from 'node:assert/strict'
import test from 'node:test'

import type { ScreenshotDevicePresetSnapshot } from '@viewport-lab/shared'

import type { RecordedStep } from './test-script-generator.js'
import { generateSpec } from './test-script-generator.js'

test('registers a dialog handler before the action that triggers it', () => {
  const spec = generateSpec(device(), 'https://example.com', '确认提交', [
    step(1, 'click', ['f1'], null),
    step(2, 'dialog-accept', [], {
      type: 'confirm',
      message: '确定提交吗？',
      status: 'handled',
      action: 'accept',
      promptText: null,
      triggerStepIndex: 1,
    }),
  ])

  const handlerIndex = spec.indexOf("page.once('dialog'")
  const clickIndex = spec.indexOf('.click()')
  assert.ok(handlerIndex > 0)
  assert.ok(clickIndex > handlerIndex)
  assert.equal(spec.match(/page\.once\('dialog'/g)?.length, 1)
})

test('registers a prompt handler before initial navigation and preserves prompt text', () => {
  const spec = generateSpec(device(), 'https://example.com', '填写姓名', [
    step(1, 'dialog-accept', ['小雨点'], {
      type: 'prompt',
      message: '请输入姓名',
      status: 'handled',
      action: 'accept',
      promptText: '小雨点',
      triggerStepIndex: 0,
    }),
  ])

  assert.ok(spec.indexOf("dialog.accept('小雨点')") < spec.indexOf('page.goto'))
})

test('makes an orphan dialog action fail explicitly instead of generating late handling code', () => {
  const spec = generateSpec(device(), 'https://example.com', '处理弹窗', [
    step(1, 'dialog-dismiss', [], null),
  ])

  assert.match(spec, /缺少可确认的触发步骤/)
  assert.doesNotMatch(spec, /page\.once\('dialog'/)
})

test('registers and uploads the default fixture after a file chooser trigger', () => {
  const uploadStep = step(1, 'click', ['f1'], null)
  uploadStep.fileUpload = { fileName: 'default-photo.png', status: 'uploaded', error: null }
  const spec = generateSpec(device(), 'https://example.com', '上传作品', [uploadStep])

  assert.ok(spec.indexOf("waitForEvent('filechooser')") < spec.indexOf('.click()'))
  assert.match(spec, /fixtures\/agent-upload\/default-photo\.png/)
  assert.match(spec, /\.setFiles\(/)
})

function step(
  stepIndex: number,
  command: string,
  args: string[],
  dialog: Exclude<RecordedStep['dialog'], undefined>,
): RecordedStep {
  return {
    stepIndex,
    command,
    args,
    purpose: `执行 ${command}`,
    locator: command === 'click' ? "getByRole('button', { name: '提交' })" : null,
    replayLocator: null,
    dialog,
  }
}

function device(): ScreenshotDevicePresetSnapshot {
  return {
    selectionId: 'iphone-390x844',
    platformId: 'ios-phone',
    platformName: '苹果手机',
    presetId: 'iphone-390x844',
    presetName: '390 × 844',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    fullPage: false,
    readySelector: '',
    captureDelayMs: 0,
  }
}
