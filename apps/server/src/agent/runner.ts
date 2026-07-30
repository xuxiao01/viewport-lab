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
import { createCliBridge } from './cli-bridge.js'
import type { AgentCliBridge } from './cli-bridge.js'
import { readAgentGatewayConfig } from './config.js'
import type { AgentGatewayConfig } from './config.js'
import { getDeviceAgentSessionId, runDeviceAgent } from './device-agent.js'
import {
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
const cancelledRunIds = new Set<string>()
const activeRunExecutions = new Map<string, Promise<void>>()
const activeDeviceSessions = new Map<
  string,
  Map<string, { bridge: AgentCliBridge; session: string }>
>()
export const AGENT_DEVICE_CONCURRENCY = 5
const agentDeviceScheduler = new ConcurrencyScheduler(AGENT_DEVICE_CONCURRENCY)

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
    replaySteps: [],
    viewportMetrics: null,
    screenshotPixelSize: null,
    finalScreenshotPath: null,
    finalScreenshotUrl: null,
    testScriptUrl: null,
    error: null,
    summary: null,
    durationMs: null,
  }))

  const initialRun: AgentRun = {
    kind: 'agent',
    executionMode: 'per_device',
    leaderDeviceId: null,
    runId,
    createdAt,
    updatedAt: createdAt,
    rerunAt: null,
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

  const execution = (async () => {
    try {
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
  })()
  trackRunExecution(runId, execution)

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
    await Promise.all(
      selectedDevices.map((device) => clearDeviceArtifacts(sourceRun.runId, device.selectionId)),
    )
    const selectedIds = new Set(selectedDevices.map((device) => device.selectionId))
    const rerunAt = new Date().toISOString()
    const gatewayConfig = readAgentGatewayConfig()
    const initialRun: AgentRun = {
      ...sourceRun,
      executionMode: 'per_device',
      leaderDeviceId: null,
      updatedAt: rerunAt,
      rerunAt,
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
              replaySteps: [],
              viewportMetrics: null,
              screenshotPixelSize: null,
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

    await recorder.persist()
    registerActiveAgentRecorder(recorder)
    emit({ type: 'status', run: recorder.run })

    const execution = (async () => {
      try {
        recorder.setStatus('running')
        await recorder.persist()
        emit({ type: 'status', run: recorder.run })
        await runAllDevices({
          recorder,
          devices: sourceRun.devices,
          captureDeviceIds: selectedIds,
          url: sourceRun.url,
          task: sourceRun.task,
          maxTurns: sourceRun.maxTurns,
          runId: sourceRun.runId,
          gatewayConfig,
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
    })()
    trackRunExecution(sourceRun.runId, execution)

    return {
      run: recorder.run,
      selectionIds: [...selectedIds],
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

async function runAllDevices(params: {
  recorder: AgentRunRecorder
  devices: ScreenshotDevicePresetSnapshot[]
  captureDeviceIds?: ReadonlySet<string>
  url: string
  task: string
  maxTurns: number
  runId: string
  gatewayConfig: AgentGatewayConfig | null
  emit: AgentEventSink
}): Promise<void> {
  const executionStartedAt = Date.now()
  const { recorder, devices, url, task, maxTurns, runId, gatewayConfig, emit } = params
  const targetDevices = params.captureDeviceIds
    ? devices.filter((device) => params.captureDeviceIds?.has(device.selectionId))
    : devices
  let persistQueue = Promise.resolve()
  const queuePersist = (): void => {
    persistQueue = persistQueue.then(
      () => recorder.persist(),
      () => recorder.persist(),
    )
  }
  const artifacts = new Map(
    await Promise.all(
      targetDevices.map(
        async (device) =>
          [device.selectionId, await ensureDeviceDirs(runId, device.selectionId)] as const,
      ),
    ),
  )

  await Promise.all(
    targetDevices.map((device) =>
      scheduleAgentDevice(async () => {
        if (cancelledRunIds.has(runId)) {
          recorder.setDeviceStatus(device.selectionId, 'cancelled', '任务已取消')
          queuePersist()
          emit({
            type: 'device_status',
            runId,
            deviceId: device.selectionId,
            status: 'cancelled',
            error: '任务已取消',
          })
          return
        }
        const cliBridge = createCliBridge()
        const session = getDeviceAgentSessionId(runId, device.selectionId)
        registerDeviceSession(runId, device.selectionId, cliBridge, session)
        try {
          const deviceRun = await runDeviceAgent({
            device,
            artifacts: artifacts.get(device.selectionId)!,
            url,
            task,
            maxTurns,
            runId,
            gatewayConfig,
            cliBridge,
            isCancelled: () => cancelledRunIds.has(runId),
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
          recorder.updateDeviceRun(deviceRun.deviceId, deviceRun)
          queuePersist()
          emit({
            type: 'device_completed',
            runId,
            deviceId: deviceRun.deviceId,
            deviceRun,
            run: recorder.run,
          })
        } finally {
          unregisterDeviceSession(runId, device.selectionId)
        }
      }),
    ),
  )

  await persistQueue
  const now = new Date().toISOString()
  const wasCancelled = cancelledRunIds.has(runId)
  const allCompleted = recorder.run.deviceRuns.every((dr) => dr.status === 'completed')
  const anyFailed = recorder.run.deviceRuns.some((dr) => dr.status === 'failed')
  const batchStatus: AgentRunStatus = wasCancelled
    ? 'cancelled'
    : allCompleted
      ? 'completed'
      : anyFailed
        ? 'failed'
        : 'completed'
  recorder.setStatus(batchStatus)
  recorder.update({ completedAt: now, durationMs: Date.now() - executionStartedAt })
  await recorder.persist()
  emit({ type: 'status', run: recorder.run })
}

export async function cancelAgentRun(runId: string): Promise<void> {
  cancelledRunIds.add(runId)
  const sessions = [...(activeDeviceSessions.get(runId)?.values() ?? [])]
  await Promise.all(
    sessions.map(({ bridge, session }) => bridge.close(session).catch(() => undefined)),
  )
  await activeRunExecutions.get(runId)
}

function trackRunExecution(runId: string, execution: Promise<void>): void {
  activeRunExecutions.set(runId, execution)
  void execution.finally(() => {
    if (activeRunExecutions.get(runId) === execution) activeRunExecutions.delete(runId)
    cancelledRunIds.delete(runId)
  })
}

function registerDeviceSession(
  runId: string,
  deviceId: string,
  bridge: AgentCliBridge,
  session: string,
): void {
  const sessions = activeDeviceSessions.get(runId) ?? new Map()
  sessions.set(deviceId, { bridge, session })
  activeDeviceSessions.set(runId, sessions)
}

function unregisterDeviceSession(runId: string, deviceId: string): void {
  const sessions = activeDeviceSessions.get(runId)
  sessions?.delete(deviceId)
  if (sessions?.size === 0) activeDeviceSessions.delete(runId)
}

function scheduleAgentDevice(task: () => Promise<void>): Promise<void> {
  return new Promise((resolve, reject) => {
    agentDeviceScheduler.enqueue(async () => {
      try {
        await task()
        resolve()
      } catch (error) {
        reject(error)
        throw error
      }
    })
  })
}
