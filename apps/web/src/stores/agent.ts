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
  ScreenshotDevicePresetSnapshot,
} from '@viewport-lab/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { getPresetSelectionId, viewportPresets } from '../config/viewport-presets'
import type { PlatformId, ViewportPreset } from '../types/capture'

const terminalStatuses = new Set<AgentRun['status']>(['completed', 'failed', 'cancelled'])

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
  const creating = ref(false)
  const error = ref<string | null>(null)
  const eventSource = ref<EventSource | null>(null)

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
    selectedRunId.value = runId
    try {
      const response = await fetch(`/api/agent/runs/${runId}`)
      if (!response.ok) throw new Error(await readApiError(response, '无法加载 Agent 运行详情'))
      currentRun.value = ((await response.json()) as GetAgentRunResponse).run
      if (!terminalStatuses.has(currentRun.value.status)) watchRun(runId)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '无法加载 Agent 运行详情'
    }
  }

  function watchRun(runId: string): void {
    stopWatching()
    const source = new EventSource(`/api/agent/runs/${runId}/events`)
    eventSource.value = source

    source.addEventListener('status', (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as AgentEvent
      if (event.type === 'status') currentRun.value = event.run
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
        currentRun.value = event.run
      }
    })
    source.addEventListener('device_completed', (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as AgentEvent
      if (event.type === 'device_completed' && currentRun.value) {
        currentRun.value = {
          ...currentRun.value,
          deviceRuns: currentRun.value.deviceRuns.map((dr) =>
            dr.deviceId === event.deviceId ? event.deviceRun : dr,
          ),
        }
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

  async function createRun(params: {
    url: string
    task: string
    note: string
    selectedPresetIds: string[]
    maxTurns: number
  }): Promise<void> {
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
      const response = await fetch('/api/agent/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error(await readApiError(response, '创建 Agent 运行失败'))
      const run = ((await response.json()) as CreateAgentRunResponse).run
      currentRun.value = run
      selectedRunId.value = run.runId
      await loadHistory()
      if (!terminalStatuses.has(run.status)) watchRun(run.runId)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '创建 Agent 运行失败'
    } finally {
      creating.value = false
    }
  }

  async function deleteRun(runId: string): Promise<void> {
    const response = await fetch(`/api/agent/runs/${runId}`, { method: 'DELETE' })
    if (!response.ok) throw new Error(await readApiError(response, '删除 Agent 运行失败'))
    runHistory.value = runHistory.value.filter((item) => item.runId !== runId)
    if (selectedRunId.value === runId) {
      stopWatching()
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
    creating,
    error,
    isRunning,
    deviceRuns,
    completedDeviceCount,
    loadGatewayStatus,
    loadHistory,
    selectRun,
    createRun,
    deleteRun,
    stopWatching,
  }
})
