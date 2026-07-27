import type {
  AgentRun,
  AgentRunStatus,
  DeviceAgentRun,
  ScreenshotDevicePresetSnapshot,
} from '@viewport-lab/shared'
import type { AgentEvent } from '@viewport-lab/shared'
import { randomUUID } from 'node:crypto'

import type { AgentCliBridge } from './cli-bridge.js'
import { createCliBridge } from './cli-bridge.js'
import { readAgentGatewayConfig } from './config.js'
import type { AgentGatewayConfig } from './config.js'
import { runDeviceAgent } from './device-agent.js'
import { ensureDeviceDirs, ensureRunDirs, AgentRunRecorder } from './recorder.js'

export type AgentEventSink = (event: AgentEvent) => void
export type { AgentEvent } from '@viewport-lab/shared'

export async function startAgentRun(params: {
  url: string
  task: string
  note: string
  devices: ScreenshotDevicePresetSnapshot[]
  maxTurns: number
  emit: AgentEventSink
}): Promise<AgentRun> {
  const { url, task, note, devices, maxTurns, emit } = params
  if (devices.length === 0) throw new Error('Agent run 至少需要一个设备预设')
  if (maxTurns < 1 || maxTurns > 100) throw new Error('maxTurns 必须在 1 到 100 之间')

  const runId = randomUUID()
  const persisted = await ensureRunDirs(runId)
  const createdAt = new Date().toISOString()

  const deviceRuns: DeviceAgentRun[] = devices.map((device) => ({
    deviceId: device.selectionId,
    platformId: device.platformId,
    presetId: device.presetId,
    presetName: device.presetName,
    cliDeviceName: '',
    status: 'queued',
    steps: [],
    testScriptUrl: null,
    error: null,
    summary: null,
    durationMs: null,
  }))

  const initialRun: AgentRun = {
    runId,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    status: 'running',
    url,
    task,
    note,
    devices,
    maxTurns,
    deviceRuns,
    error: null,
    durationMs: null,
  }

  const recorder = new AgentRunRecorder(persisted, initialRun)
  const gatewayConfig = readAgentGatewayConfig()
  const cliBridge = createCliBridge()

  emit({ type: 'status', run: recorder.run })

  void runAllDevices({
    recorder,
    devices,
    url,
    task,
    note,
    maxTurns,
    runId,
    gatewayConfig,
    cliBridge,
    emit,
  })
    .catch((error: unknown) => {
      recorder.setStatus('failed', error instanceof Error ? error.message : 'Agent 运行异常')
      emit({ type: 'status', run: recorder.run })
    })
    .finally(async () => {
      await cliBridge.closeAll()
      await recorder.persist()
    })

  return recorder.run
}

async function runAllDevices(params: {
  recorder: AgentRunRecorder
  devices: ScreenshotDevicePresetSnapshot[]
  url: string
  task: string
  note: string
  maxTurns: number
  runId: string
  gatewayConfig: AgentGatewayConfig | null
  cliBridge: AgentCliBridge
  emit: AgentEventSink
}): Promise<void> {
  const { recorder, devices, url, task, note, maxTurns, runId, gatewayConfig, cliBridge, emit } =
    params

  const results = await Promise.allSettled(
    devices.map(async (device) => {
      const deviceDirs = await ensureDeviceDirs(runId, device.selectionId)

      return runDeviceAgent({
        device,
        url,
        task,
        note,
        maxTurns,
        runId,
        gatewayConfig,
        cliBridge,
        screenshotsDir: deviceDirs.screenshotsDir,
        snapshotsDir: deviceDirs.snapshotsDir,
        specDir: deviceDirs.specDir,
        onDeviceStatus: (deviceId, status, error) => {
          recorder.setDeviceStatus(deviceId, status, error)
          recorder.persist().catch(() => undefined)
          emit({ type: 'device_status', runId, deviceId, status, error })
          emit({ type: 'status', run: recorder.run })
        },
        onDeviceStep: (deviceId, step) => {
          recorder.appendDeviceStep(deviceId, step)
          recorder.persist().catch(() => undefined)
          emit({ type: 'device_step', runId, deviceId, step, run: recorder.run })
        },
      })
    }),
  )

  const now = new Date().toISOString()
  for (let i = 0; i < devices.length; i++) {
    const device = devices[i]
    const result = results[i]
    if (!device || !result) continue

    if (result.status === 'fulfilled') {
      const dr = result.value
      recorder.updateDeviceRun(device.selectionId, dr)
      emit({
        type: 'device_completed',
        runId,
        deviceId: device.selectionId,
        deviceRun: dr,
        run: recorder.run,
      })
    } else {
      const error = result.reason instanceof Error ? result.reason.message : String(result.reason)
      recorder.updateDeviceRun(device.selectionId, {
        status: 'failed',
        error,
        durationMs: 0,
      })
      emit({
        type: 'device_completed',
        runId,
        deviceId: device.selectionId,
        deviceRun: recorder.run.deviceRuns[i]!,
        run: recorder.run,
      })
    }
  }

  const allCompleted = recorder.run.deviceRuns.every((dr) => dr.status === 'completed')
  const anyFailed = recorder.run.deviceRuns.some((dr) => dr.status === 'failed')
  const batchStatus: AgentRunStatus = allCompleted
    ? 'completed'
    : anyFailed
      ? 'failed'
      : 'completed'
  recorder.setStatus(batchStatus)
  recorder.update({ completedAt: now })
  await recorder.persist()
  emit({ type: 'status', run: recorder.run })
}
