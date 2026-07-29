import type {
  AgentEvent,
  AgentGatewayStatus,
  AgentRun,
  AgentRunSummary,
  CaptureDelayMs,
  CreateAgentRunRequest,
  CreateAgentRunResponse,
  DeviceAgentRun,
  GetAgentRunResponse,
  ListAgentRunsResponse,
  RerunAgentRunResponse,
  RerunScope,
  ScreenshotDevicePresetSnapshot,
  UpdateAgentRerunListResponse,
} from '@viewport-lab/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { getPresetSelectionId, viewportPresets } from '../config/viewport-presets'
import type { PlatformId, ViewportPreset } from '../types/capture'

const terminalStatuses = new Set<AgentRun['status']>(['completed', 'failed', 'cancelled'])

function toRunSummary(run: AgentRun): AgentRunSummary {
  return {
    kind: 'agent',
    executionMode: run.executionMode,
    leaderDeviceId: run.leaderDeviceId,
    runId: run.runId,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    status: run.status,
    url: run.url,
    task: run.task,
    note: run.note,
    model: run.model,
    deviceCount: run.devices.length,
    completedDeviceCount: run.deviceRuns.filter((device) => device.status === 'completed').length,
    failedDeviceCount: run.deviceRuns.filter((device) => device.status === 'failed').length,
    stepCount: run.deviceRuns.reduce((sum, device) => sum + device.steps.length, 0),
    durationMs: run.durationMs,
  }
}

function buildDeviceSnapshot(
  platformId: PlatformId,
  preset: ViewportPreset,
  captureDelayMs: CaptureDelayMs = 0,
): ScreenshotDevicePresetSnapshot {
  const platform = viewportPresets.find((item) => item.id === platformId)
  return {
    selectionId: getPresetSelectionId(platformId, preset.id),
    platformId,
    platformName: platform?.name ?? platformId,
    presetId: preset.id,
    presetName: preset.name,
    viewport: { ...preset.viewport },
    deviceScaleFactor: preset.deviceScaleFactor,
    isMobile: preset.isMobile,
    hasTouch: preset.hasTouch,
    fullPage: preset.fullPage,
    readySelector: preset.readySelector,
    captureDelayMs,
  }
}

export const useAgentStore = defineStore('agent', () => {
  const gatewayStatus = ref<AgentGatewayStatus | null>(null)
  const runHistory = ref<AgentRunSummary[]>([])
  const currentRun = ref<AgentRun | null>(null)
  const selectedRunId = ref<string | null>(null)
  const historyLoading = ref(false)
  const detailLoading = ref(false)
  const creating = ref(false)
  const rerunning = ref(false)
  const rerunListUpdatingDeviceId = ref<string | null>(null)
  const error = ref<string | null>(null)
  const eventSource = ref<EventSource | null>(null)
  let activeRerunDeviceIds: Set<string> | null = null

  const isRunning = computed(
    () => currentRun.value !== null && !terminalStatuses.has(currentRun.value.status),
  )

  const deviceRuns = computed<DeviceAgentRun[]>(() => currentRun.value?.deviceRuns ?? [])
  const completedDeviceCount = computed(
    () =>
      deviceRuns.value.filter((dr) => dr.status === 'completed' || dr.status === 'failed').length,
  )

  async function readApiError(response: Response, fallback: string): Promise<string> {
    try {
      const payload = (await response.json()) as { error?: string }
      if (typeof payload.error === 'string') return payload.error
    } catch {
      // use fallback
    }
    return fallback
  }

  async function loadGatewayStatus(): Promise<void> {
    try {
      const response = await fetch('/api/agent/gateway-status')
      if (!response.ok) throw new Error('无法获取 Agent 网关状态')
      gatewayStatus.value = (await response.json()) as AgentGatewayStatus
    } catch (err) {
      gatewayStatus.value = {
        configured: false,
        model: null,
        vhost: null,
        reason: err instanceof Error ? err.message : '未知错误',
      }
    }
  }

  async function loadHistory(): Promise<void> {
    historyLoading.value = true
    error.value = null
    try {
      const response = await fetch('/api/agent/runs')
      if (!response.ok) throw new Error(await readApiError(response, '无法加载 Agent 运行历史'))
      runHistory.value = ((await response.json()) as ListAgentRunsResponse).runs
    } catch (err) {
      error.value = err instanceof Error ? err.message : '无法加载 Agent 运行历史'
    } finally {
      historyLoading.value = false
    }
  }

  async function selectRun(runId: string): Promise<void> {
    stopWatching()
    activeRerunDeviceIds = null
    selectedRunId.value = runId
    detailLoading.value = true
    try {
      const response = await fetch(`/api/agent/runs/${runId}`)
      if (!response.ok) throw new Error(await readApiError(response, '无法加载 Agent 运行详情'))
      currentRun.value = ((await response.json()) as GetAgentRunResponse).run
      if (!terminalStatuses.has(currentRun.value.status)) watchRun(runId)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '无法加载 Agent 运行详情'
    } finally {
      detailLoading.value = false
    }
  }

  function upsertHistory(run: AgentRun): void {
    const summary = toRunSummary(run)
    runHistory.value = [
      summary,
      ...runHistory.value.filter((item) => item.runId !== summary.runId),
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  function mergeRunUpdate(incomingRun: AgentRun): AgentRun {
    const current = currentRun.value
    if (!current || current.runId !== incomingRun.runId || activeRerunDeviceIds === null) {
      return incomingRun
    }
    const incomingDevices = new Map(
      incomingRun.deviceRuns.map((deviceRun) => [deviceRun.deviceId, deviceRun]),
    )
    return {
      ...incomingRun,
      devices: current.devices,
      deviceRuns: current.deviceRuns.map((deviceRun) =>
        activeRerunDeviceIds!.has(deviceRun.deviceId)
          ? (incomingDevices.get(deviceRun.deviceId) ?? deviceRun)
          : deviceRun,
      ),
    }
  }

  function applyRunUpdate(incomingRun: AgentRun): AgentRun {
    const mergedRun = mergeRunUpdate(incomingRun)
    currentRun.value = mergedRun
    upsertHistory(mergedRun)
    if (terminalStatuses.has(mergedRun.status)) activeRerunDeviceIds = null
    return mergedRun
  }

  function watchRun(runId: string): void {
    stopWatching()
    const source = new EventSource(`/api/agent/runs/${runId}/events`)
    eventSource.value = source

    source.addEventListener('status', (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as AgentEvent
      if (event.type === 'status') {
        applyRunUpdate(event.run)
      }
    })
    source.addEventListener('device_status', (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as AgentEvent
      if (event.type === 'device_status' && currentRun.value) {
        currentRun.value = {
          ...currentRun.value,
          deviceRuns: currentRun.value.deviceRuns.map((dr) =>
            dr.deviceId === event.deviceId
              ? { ...dr, status: event.status, error: event.error }
              : dr,
          ),
        }
      }
    })
    source.addEventListener('device_step', (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as AgentEvent
      if (event.type === 'device_step' && currentRun.value) {
        applyRunUpdate(event.run)
      }
    })
    source.addEventListener('device_completed', (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as AgentEvent
      if (event.type === 'device_completed' && currentRun.value) {
        applyRunUpdate(event.run)
      }
    })
    source.addEventListener('log', (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as AgentEvent
      if (event.type === 'log' && event.level === 'error') {
        error.value = event.message
      }
    })
    source.onerror = () => {
      stopWatching()
    }
  }

  function stopWatching(): void {
    eventSource.value?.close()
    eventSource.value = null
  }

  async function submitRun(payload: CreateAgentRunRequest): Promise<AgentRun> {
    const response = await fetch('/api/agent/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error(await readApiError(response, '创建 Agent 运行失败'))
    const run = ((await response.json()) as CreateAgentRunResponse).run
    activeRerunDeviceIds = null
    currentRun.value = run
    selectedRunId.value = run.runId
    upsertHistory(run)
    if (!terminalStatuses.has(run.status)) watchRun(run.runId)
    return run
  }

  async function createRun(params: {
    url: string
    task: string
    note: string
    selectedPresetIds: string[]
    maxTurns: number
  }): Promise<AgentRun | null> {
    creating.value = true
    error.value = null
    try {
      const selectedIds = new Set(params.selectedPresetIds)
      const devices: ScreenshotDevicePresetSnapshot[] = []
      for (const platform of viewportPresets) {
        for (const preset of platform.presets) {
          const selectionId = getPresetSelectionId(platform.id, preset.id)
          if (selectedIds.has(selectionId)) {
            devices.push(buildDeviceSnapshot(platform.id, preset))
          }
        }
      }
      if (devices.length === 0) throw new Error('至少选择一个设备视口')
      const payload: CreateAgentRunRequest = {
        url: params.url.trim(),
        task: params.task.trim(),
        note: params.note.trim(),
        devices,
        maxTurns: params.maxTurns,
      }
      return await submitRun(payload)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '创建 Agent 运行失败'
      return null
    } finally {
      creating.value = false
    }
  }

  async function createRunFromSnapshots(payload: CreateAgentRunRequest): Promise<AgentRun | null> {
    creating.value = true
    error.value = null
    try {
      if (payload.devices.length === 0) throw new Error('至少选择一个设备视口')
      return await submitRun({
        ...payload,
        url: payload.url.trim(),
        task: payload.task.trim(),
        note: payload.note.trim(),
        devices: payload.devices.map((device) => ({
          ...device,
          viewport: { ...device.viewport },
        })),
      })
    } catch (err) {
      error.value = err instanceof Error ? err.message : '创建 Agent 运行失败'
      return null
    } finally {
      creating.value = false
    }
  }

  async function rerunRun(runId: string, scope: RerunScope = 'all'): Promise<AgentRun | null> {
    rerunning.value = true
    error.value = null
    try {
      const response = await fetch(`/api/agent/runs/${runId}/rerun`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope }),
      })
      if (!response.ok) throw new Error(await readApiError(response, '重跑 Agent 批次失败'))
      const result = (await response.json()) as RerunAgentRunResponse
      activeRerunDeviceIds = new Set(result.selectionIds)
      const run = applyRunUpdate(result.run)
      selectedRunId.value = run.runId
      watchRun(run.runId)
      return run
    } catch (err) {
      activeRerunDeviceIds = null
      error.value = err instanceof Error ? err.message : '重跑 Agent 批次失败'
      return null
    } finally {
      rerunning.value = false
    }
  }

  async function updateRerunList(deviceId: string, included: boolean): Promise<void> {
    const run = currentRun.value
    if (!run) throw new Error('请先选择 Agent 批次')
    rerunListUpdatingDeviceId.value = deviceId
    error.value = null
    try {
      const response = await fetch(`/api/agent/runs/${run.runId}/rerun-list`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId, included }),
      })
      if (!response.ok) throw new Error(await readApiError(response, '更新重跑清单失败'))
      const result = (await response.json()) as UpdateAgentRerunListResponse
      if (currentRun.value?.runId === run.runId) {
        currentRun.value = {
          ...currentRun.value,
          rerunDeviceIds: result.rerunDeviceIds,
        }
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : '更新重跑清单失败'
      throw err
    } finally {
      rerunListUpdatingDeviceId.value = null
    }
  }

  async function deleteRun(runId: string): Promise<void> {
    const response = await fetch(`/api/agent/runs/${runId}`, { method: 'DELETE' })
    if (!response.ok) throw new Error(await readApiError(response, '删除 Agent 运行失败'))
    runHistory.value = runHistory.value.filter((item) => item.runId !== runId)
    if (selectedRunId.value === runId) {
      stopWatching()
      activeRerunDeviceIds = null
      selectedRunId.value = null
      currentRun.value = null
    }
  }

  return {
    gatewayStatus,
    runHistory,
    currentRun,
    selectedRunId,
    historyLoading,
    detailLoading,
    creating,
    rerunning,
    rerunListUpdatingDeviceId,
    error,
    isRunning,
    deviceRuns,
    completedDeviceCount,
    loadGatewayStatus,
    loadHistory,
    selectRun,
    createRun,
    createRunFromSnapshots,
    rerunRun,
    updateRerunList,
    deleteRun,
    stopWatching,
  }
})
