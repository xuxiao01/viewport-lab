import type {
  AgentRun,
  AgentRunStatus,
  DeviceAgentRun,
  RerunScope,
  ScreenshotDevicePresetSnapshot,
} from '@viewport-lab/shared'
import type { AgentEvent } from '@viewport-lab/shared'
import { createArchiveId } from '../run-archive.js'
import type { AgentCliBridge } from './cli-bridge.js'
import { createCliBridge } from './cli-bridge.js'
import { readAgentGatewayConfig } from './config.js'
import type { AgentGatewayConfig } from './config.js'
import { runDeviceAgent } from './device-agent.js'
import {
  clearDeviceArtifacts,
  ensureDeviceDirs,
  ensureRunDirs,
  AgentRunRecorder,
} from './recorder.js'

export type AgentEventSink = (event: AgentEvent) => void
export type { AgentEvent } from '@viewport-lab/shared'

const activeRerunIds = new Set<string>()
const AGENT_DEVICE_CONCURRENCY = 6

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

  const runId = createArchiveId()
  const persisted = await ensureRunDirs(runId)
  const createdAt = new Date().toISOString()
  const gatewayConfig = readAgentGatewayConfig()

  const deviceRuns: DeviceAgentRun[] = devices.map((device) => ({
    deviceId: device.selectionId,
    platformId: device.platformId,
    presetId: device.presetId,
    presetName: device.presetName,
    cliDeviceName: '',
    status: 'queued',
    steps: [],
    finalScreenshotPath: null,
    finalScreenshotUrl: null,
    testScriptUrl: null,
    error: null,
    summary: null,
    durationMs: null,
  }))

  const initialRun: AgentRun = {
    kind: 'agent',
    runId,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    status: 'running',
    url,
    task,
    note,
    model: gatewayConfig?.model ?? null,
    devices,
    maxTurns,
    deviceRuns,
    rerunDeviceIds: [],
    error: null,
    durationMs: null,
  }

  const recorder = new AgentRunRecorder(persisted, initialRun)
  const cliBridge = createCliBridge()

  await recorder.persist()
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

export async function rerunAgentRunInPlace(params: {
  sourceRun: AgentRun
  scope: RerunScope
  emit: AgentEventSink
}): Promise<{ run: AgentRun; selectionIds: string[] }> {
  const { sourceRun, scope, emit } = params
  if (activeRerunIds.has(sourceRun.runId)) throw new Error('该 Agent 批次正在重跑')
  activeRerunIds.add(sourceRun.runId)
  const rerunListIds = new Set(sourceRun.rerunDeviceIds)
  const selectedDevices = sourceRun.devices.filter((device) => {
    if (scope === 'all') return true
    if (scope === 'list') return rerunListIds.has(device.selectionId)
    return sourceRun.deviceRuns.some(
      (deviceRun) => deviceRun.deviceId === device.selectionId && deviceRun.status === 'failed',
    )
  })
  if (selectedDevices.length === 0) {
    activeRerunIds.delete(sourceRun.runId)
    throw new Error(scope === 'list' ? '当前批次的重跑清单为空' : '当前批次没有失败设备')
  }

  try {
    await Promise.all(
      selectedDevices.map((device) => clearDeviceArtifacts(sourceRun.runId, device.selectionId)),
    )
    const selectedIds = new Set(selectedDevices.map((device) => device.selectionId))
    const rerunAt = new Date().toISOString()
    const gatewayConfig = readAgentGatewayConfig()
    const initialRun: AgentRun = {
      ...sourceRun,
      updatedAt: rerunAt,
      completedAt: null,
      status: 'running',
      model: gatewayConfig?.model ?? sourceRun.model,
      deviceRuns: sourceRun.deviceRuns.map((deviceRun) =>
        selectedIds.has(deviceRun.deviceId)
          ? {
              ...deviceRun,
              cliDeviceName: '',
              status: 'queued',
              steps: [],
              finalScreenshotPath: null,
              finalScreenshotUrl: null,
              testScriptUrl: null,
              error: null,
              summary: null,
              durationMs: null,
            }
          : deviceRun,
      ),
      error: null,
      durationMs: null,
    }
    const persisted = await ensureRunDirs(sourceRun.runId)
    const recorder = new AgentRunRecorder(persisted, initialRun)
    const cliBridge = createCliBridge()

    await recorder.persist()
    emit({ type: 'status', run: recorder.run })

    void runAllDevices({
      recorder,
      devices: selectedDevices,
      url: sourceRun.url,
      task: sourceRun.task,
      note: sourceRun.note,
      maxTurns: sourceRun.maxTurns,
      runId: sourceRun.runId,
      gatewayConfig,
      cliBridge,
      emit,
    })
      .catch((error: unknown) => {
        recorder.setStatus('failed', error instanceof Error ? error.message : 'Agent 运行异常')
        emit({ type: 'status', run: recorder.run })
      })
      .finally(async () => {
        try {
          await cliBridge.closeAll()
          await recorder.persist()
        } finally {
          activeRerunIds.delete(sourceRun.runId)
        }
      })

    return {
      run: recorder.run,
      selectionIds: selectedDevices.map((device) => device.selectionId),
    }
  } catch (error) {
    activeRerunIds.delete(sourceRun.runId)
    throw error
  }
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
  const executionStartedAt = Date.now()
  const { recorder, devices, url, task, note, maxTurns, runId, gatewayConfig, cliBridge, emit } =
    params

  let nextDeviceIndex = 0

  async function runNextDevices(): Promise<void> {
    while (true) {
      const deviceIndex = nextDeviceIndex
      nextDeviceIndex += 1
      const device = devices[deviceIndex]
      if (!device) return

      try {
        const deviceDirs = await ensureDeviceDirs(runId, device.selectionId)
        const deviceRun = await runDeviceAgent({
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
          finalScreenshotPath: deviceDirs.finalScreenshotPath,
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
        recorder.updateDeviceRun(device.selectionId, deviceRun)
        await recorder.persist().catch(() => undefined)
        emit({
          type: 'device_completed',
          runId,
          deviceId: device.selectionId,
          deviceRun,
          run: recorder.run,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        recorder.updateDeviceRun(device.selectionId, {
          status: 'failed',
          error: message,
          durationMs: 0,
        })
        await recorder.persist().catch(() => undefined)
        emit({
          type: 'device_completed',
          runId,
          deviceId: device.selectionId,
          deviceRun: recorder.run.deviceRuns.find(
            (deviceRun) => deviceRun.deviceId === device.selectionId,
          )!,
          run: recorder.run,
        })
      }
    }
  }

  const workerCount = Math.min(AGENT_DEVICE_CONCURRENCY, devices.length)
  await Promise.all(Array.from({ length: workerCount }, () => runNextDevices()))

  const now = new Date().toISOString()
  const allCompleted = recorder.run.deviceRuns.every((dr) => dr.status === 'completed')
  const anyFailed = recorder.run.deviceRuns.some((dr) => dr.status === 'failed')
  const batchStatus: AgentRunStatus = allCompleted
    ? 'completed'
    : anyFailed
      ? 'failed'
      : 'completed'
  recorder.setStatus(batchStatus)
  recorder.update({ completedAt: now, durationMs: Date.now() - executionStartedAt })
  await recorder.persist()
  emit({ type: 'status', run: recorder.run })
}
