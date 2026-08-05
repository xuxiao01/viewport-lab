import assert from 'node:assert/strict'
import test from 'node:test'

import type { AgentRun, DeviceAgentRun, ScreenshotDevicePresetSnapshot } from '@viewport-lab/shared'

import { normalizeAgentRun } from './recorder.js'
import {
  AGENT_DEVICE_CONCURRENCY,
  removeCompletedRerunListDevices,
  selectRerunDevices,
} from './runner.js'

test('limits the global Agent device pool to two independent Agents', () => {
  assert.equal(AGENT_DEVICE_CONCURRENCY, 2)
})

test('normalizes legacy manifests as independent per-device Agent runs', () => {
  const run = makeRun()
  delete (run as Partial<AgentRun>).executionMode
  delete (run as Partial<AgentRun>).leaderDeviceId
  delete (run as Partial<AgentRun>).rerunAt

  const normalized = normalizeAgentRun(run)

  assert.equal(normalized.executionMode, 'per_device')
  assert.equal(normalized.leaderDeviceId, null)
  assert.equal(normalized.rerunAt, null)
})

test('normalizes missing page observation fields in legacy steps', () => {
  const run = makeRun()
  run.deviceRuns[0]!.steps.push({
    stepIndex: 0,
    command: 'goto',
    args: ['https://example.com'],
    purpose: '打开页面',
    status: 'success',
    info: null,
    output: null,
    snapshot: '- main',
    screenshotUrl: null,
    locator: null,
    startedAt: run.createdAt,
    completedAt: run.createdAt,
    durationMs: 0,
  } as DeviceAgentRun['steps'][number])

  const [step] = normalizeAgentRun(run).deviceRuns[0]!.steps

  assert.equal(step?.error, null)
  assert.equal(step?.wait, null)
  assert.equal(step?.page, null)
  assert.equal(step?.snapshotMeta, null)
  assert.equal(step?.dialog, null)
})

test('keeps the single-agent resize execution mode and its configured leader', () => {
  const run = makeRun()
  run.executionMode = 'leader_resize_capture'

  const normalized = normalizeAgentRun(run)

  assert.equal(normalized.executionMode, 'leader_resize_capture')
  assert.equal(normalized.leaderDeviceId, 'device-a')
})

test('keeps the independent context replay mode and its configured leader', () => {
  const run = makeRun()
  run.executionMode = 'leader_context_replay'

  const normalized = normalizeAgentRun(run)

  assert.equal(normalized.executionMode, 'leader_context_replay')
  assert.equal(normalized.leaderDeviceId, 'device-a')
})

test('keeps rerun device ordering while retaining the original leader separately', () => {
  const run = makeRun()
  run.rerunDeviceIds = ['device-c', 'device-b']
  run.deviceRuns[1]!.status = 'failed'

  assert.deepEqual(
    selectRerunDevices(run, 'list').map((device) => device.selectionId),
    ['device-b', 'device-c'],
  )
  assert.deepEqual(
    selectRerunDevices(run, 'failed').map((device) => device.selectionId),
    ['device-b'],
  )
})

test('removes only completed manual-list devices after a list rerun settles', () => {
  assert.deepEqual(
    removeCompletedRerunListDevices(
      ['device-a', 'device-b', 'device-c'],
      new Set(['device-a', 'device-c']),
    ),
    ['device-b'],
  )
})

function makeRun(): AgentRun {
  const devices = ['device-a', 'device-b', 'device-c'].map(makeDevice)
  return {
    kind: 'agent',
    executionMode: 'leader_broadcast',
    leaderDeviceId: 'device-a',
    runId: 'test-run',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    rerunAt: null,
    completedAt: '2026-07-28T00:01:00.000Z',
    status: 'completed',
    url: 'https://example.com',
    task: '测试页面',
    note: '',
    model: 'test-model',
    devices,
    maxTurns: 10,
    deviceRuns: devices.map(makeDeviceRun),
    rerunDeviceIds: [],
    error: null,
    durationMs: 60_000,
  }
}

function makeDevice(selectionId: string): ScreenshotDevicePresetSnapshot {
  return {
    selectionId,
    platformId: 'ios-phone',
    platformName: '苹果手机',
    presetId: selectionId,
    presetName: selectionId,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    fullPage: false,
    readySelector: '',
    captureDelayMs: 0,
  }
}

function makeDeviceRun(device: ScreenshotDevicePresetSnapshot): DeviceAgentRun {
  return {
    deviceId: device.selectionId,
    platformId: device.platformId,
    presetId: device.presetId,
    presetName: device.presetName,
    cliDeviceName: '',
    status: 'completed',
    steps: [],
    replaySteps: [],
    viewportMetrics: null,
    screenshotPixelSize: null,
    finalScreenshotPath: null,
    finalScreenshotUrl: null,
    testScriptUrl: null,
    error: null,
    summary: null,
    durationMs: 0,
  }
}
