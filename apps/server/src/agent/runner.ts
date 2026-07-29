import type {
  AgentRun,
  AgentRunStatus,
  DeviceAgentRun,
  RerunScope,
  ScreenshotDevicePresetSnapshot,
} from '@viewport-lab/shared'
import type { AgentEvent } from '@viewport-lab/shared'
import { createArchiveId } from '../run-archive.js'
import { ConcurrencyScheduler } from '../task-scheduler.js'
import type { AgentCliBridge } from './cli-bridge.js'
import { createCliBridge } from './cli-bridge.js'
import { readAgentGatewayConfig } from './config.js'
import type { AgentGatewayConfig } from './config.js'
import { runSharedDeviceAgent } from './device-agent.js'
import {
  clearDeviceAgentArtifacts,
  clearDeviceArtifacts,
  ensureDeviceDirs,
  ensureRunDirs,
  AgentRunRecorder,
  registerActiveAgentRecorder,
  unregisterActiveAgentRecorder,
} from './recorder.js'

export type AgentEventSink = (event: AgentEvent) => void
export type { AgentEvent } from '@viewport-lab/shared'

const activeRerunIds = new Set<string>()
const agentScheduler = new ConcurrencyScheduler(3)

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
    executionMode: 'leader_resize_capture',
    leaderDeviceId: devices[0]!.selectionId,
    runId,
    createdAt,
    updatedAt: createdAt,
    completedAt: null,
    status: 'queued',
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

  await recorder.persist()
  registerActiveAgentRecorder(recorder)
  emit({ type: 'status', run: recorder.run })

  agentScheduler.enqueue(async () => {
    try {
      const cliBridge = createCliBridge()
      recorder.setStatus('running')
      await recorder.persist()
      emit({ type: 'status', run: recorder.run })
      await runAllDevices({
        recorder,
        devices,
        url,
        task,
        maxTurns,
        runId,
        gatewayConfig,
        cliBridge,
        emit,
      })
    } catch (error: unknown) {
      recorder.setStatus('failed', error instanceof Error ? error.message : 'Agent 运行异常')
      emit({ type: 'status', run: recorder.run })
    } finally {
      try {
        await recorder.persist()
      } finally {
        unregisterActiveAgentRecorder(runId, recorder)
      }
    }
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
  const selectedDevices = selectRerunDevices(sourceRun, scope)
  if (selectedDevices.length === 0) {
    activeRerunIds.delete(sourceRun.runId)
    throw new Error(scope === 'list' ? '当前批次的重跑清单为空' : '当前批次没有失败设备')
  }

  try {
    await Promise.all([
      ...selectedDevices.map((device) => clearDeviceArtifacts(sourceRun.runId, device.selectionId)),
      ...(selectedIdsHas(sourceRun.leaderDeviceId, selectedDevices)
        ? []
        : sourceRun.leaderDeviceId
          ? [clearDeviceAgentArtifacts(sourceRun.runId, sourceRun.leaderDeviceId)]
          : []),
    ])
    const selectedIds = new Set(selectedDevices.map((device) => device.selectionId))
    const leaderDevice =
      sourceRun.devices.find((device) => device.selectionId === sourceRun.leaderDeviceId) ??
      sourceRun.devices[0]!
    const updatedIds = new Set([...selectedIds, leaderDevice.selectionId])
    const rerunAt = new Date().toISOString()
    const gatewayConfig = readAgentGatewayConfig()
    const initialRun: AgentRun = {
      ...sourceRun,
      executionMode: 'leader_resize_capture',
      leaderDeviceId: leaderDevice.selectionId,
      updatedAt: rerunAt,
      completedAt: null,
      status: 'queued',
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
          : deviceRun.deviceId === leaderDevice.selectionId
            ? {
                ...deviceRun,
                cliDeviceName: '',
                steps: [],
                testScriptUrl: null,
                summary: null,
                error: null,
                durationMs: null,
              }
            : deviceRun,
      ),
      error: null,
      durationMs: null,
    }
    const persisted = await ensureRunDirs(sourceRun.runId)
    const recorder = new AgentRunRecorder(persisted, initialRun)

    await recorder.persist()
    registerActiveAgentRecorder(recorder)
    emit({ type: 'status', run: recorder.run })

    agentScheduler.enqueue(async () => {
      try {
        const cliBridge = createCliBridge()
        recorder.setStatus('running')
        await recorder.persist()
        emit({ type: 'status', run: recorder.run })
        await runAllDevices({
          recorder,
          devices: sourceRun.devices,
          captureDeviceIds: selectedIds,
          leaderDeviceId: leaderDevice.selectionId,
          existingDeviceRuns: initialRun.deviceRuns,
          url: sourceRun.url,
          task: sourceRun.task,
          maxTurns: sourceRun.maxTurns,
          runId: sourceRun.runId,
          gatewayConfig,
          cliBridge,
          emit,
        })
      } catch (error: unknown) {
        recorder.setStatus('failed', error instanceof Error ? error.message : 'Agent 运行异常')
        emit({ type: 'status', run: recorder.run })
      } finally {
        try {
          await recorder.persist()
        } finally {
          unregisterActiveAgentRecorder(sourceRun.runId, recorder)
          activeRerunIds.delete(sourceRun.runId)
        }
      }
    })

    return {
      run: recorder.run,
      selectionIds: [...updatedIds],
    }
  } catch (error) {
    activeRerunIds.delete(sourceRun.runId)
    throw error
  }
}

export function selectRerunDevices(
  sourceRun: AgentRun,
  scope: RerunScope,
): ScreenshotDevicePresetSnapshot[] {
  const rerunListIds = new Set(sourceRun.rerunDeviceIds)
  return sourceRun.devices.filter((device) => {
    if (scope === 'all') return true
    if (scope === 'list') return rerunListIds.has(device.selectionId)
    return sourceRun.deviceRuns.some(
      (deviceRun) => deviceRun.deviceId === device.selectionId && deviceRun.status === 'failed',
    )
  })
}

function selectedIdsHas(
  deviceId: string | null,
  devices: ScreenshotDevicePresetSnapshot[],
): boolean {
  return deviceId !== null && devices.some((device) => device.selectionId === deviceId)
}

async function runAllDevices(params: {
  recorder: AgentRunRecorder
  devices: ScreenshotDevicePresetSnapshot[]
  captureDeviceIds?: ReadonlySet<string>
  leaderDeviceId?: string
  existingDeviceRuns?: DeviceAgentRun[]
  url: string
  task: string
  maxTurns: number
  runId: string
  gatewayConfig: AgentGatewayConfig | null
  cliBridge: AgentCliBridge
  emit: AgentEventSink
}): Promise<void> {
  const executionStartedAt = Date.now()
  const { recorder, devices, url, task, maxTurns, runId, gatewayConfig, cliBridge, emit } = params
  let persistQueue = Promise.resolve()
  const queuePersist = (): void => {
    persistQueue = persistQueue.then(
      () => recorder.persist(),
      () => recorder.persist(),
    )
  }
  const artifacts = new Map(
    await Promise.all(
      devices.map(
        async (device) =>
          [device.selectionId, await ensureDeviceDirs(runId, device.selectionId)] as const,
      ),
    ),
  )

  const deviceRuns = await runSharedDeviceAgent({
    devices,
    ...(params.captureDeviceIds ? { captureDeviceIds: params.captureDeviceIds } : {}),
    ...(params.leaderDeviceId ? { leaderDeviceId: params.leaderDeviceId } : {}),
    ...(params.existingDeviceRuns ? { existingDeviceRuns: params.existingDeviceRuns } : {}),
    artifacts,
    url,
    task,
    maxTurns,
    runId,
    gatewayConfig,
    cliBridge,
    onDeviceStatus: (deviceId, status, error) => {
      recorder.setDeviceStatus(deviceId, status, error)
      queuePersist()
      emit({ type: 'device_status', runId, deviceId, status, error })
      emit({ type: 'status', run: recorder.run })
    },
    onDeviceStep: (deviceId, step) => {
      recorder.appendDeviceStep(deviceId, step)
      queuePersist()
      emit({ type: 'device_step', runId, deviceId, step, run: recorder.run })
    },
  })

  await persistQueue

  for (const deviceRun of deviceRuns) {
    recorder.updateDeviceRun(deviceRun.deviceId, deviceRun)
    emit({
      type: 'device_completed',
      runId,
      deviceId: deviceRun.deviceId,
      deviceRun,
      run: recorder.run,
    })
  }

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
