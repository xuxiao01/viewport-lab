import type {
  ApiErrorResponse,
  CreateBatchResponse,
  CreateRunRequest,
  CreateRunResponse,
  RunEvent,
  RunManifest,
  RunStatus,
} from '@viewport-lab/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { getPresetSelectionId, viewportPresets } from '../config/viewport-presets'
import type {
  CaptureTask,
  PlatformCaptureStatus,
  PlatformProgressItem,
  ViewportPreset,
} from '../types/capture'

const terminalStatuses = new Set<RunStatus>(['completed', 'failed'])

export const useRunStore = defineStore('run', () => {
  const tasks = ref<CaptureTask[]>([])
  const batchUrl = ref('')
  const batchId = ref('')
  const eventSources = new Map<string, EventSource>()
  const pollTimers = new Map<string, number>()

  const totalCount = computed(() => tasks.value.length)
  const completedCount = computed(
    () => tasks.value.filter((task) => terminalStatuses.has(task.status)).length,
  )
  const progressPercentage = computed(() =>
    totalCount.value === 0 ? 0 : Math.round((completedCount.value / totalCount.value) * 100),
  )
  const isRunning = computed(() => tasks.value.some((task) => !terminalStatuses.has(task.status)))
  const platformProgress = computed<PlatformProgressItem[]>(() =>
    viewportPresets.flatMap((platform) => {
      const platformTasks = tasks.value.filter((task) => task.platformId === platform.id)
      if (platformTasks.length === 0) return []
      const terminalCount = platformTasks.filter((task) => terminalStatuses.has(task.status)).length
      return [
        {
          platformId: platform.id,
          name: platform.name,
          status: getPlatformStatus(platformTasks),
          completed: terminalCount,
          total: platformTasks.length,
        },
      ]
    }),
  )

  function getPlatformStatus(platformTasks: CaptureTask[]): PlatformCaptureStatus {
    if (platformTasks.every((task) => task.status === 'completed')) return 'completed'
    if (
      platformTasks.every((task) => terminalStatuses.has(task.status)) &&
      platformTasks.some((task) => task.status === 'failed')
    ) {
      return 'failed'
    }
    if (platformTasks.every((task) => task.status === 'queued')) return 'waiting'
    return 'capturing'
  }

  function findTask(taskId: string): CaptureTask | undefined {
    return tasks.value.find((task) => task.id === taskId)
  }

  function updateTask(taskId: string, patch: Partial<CaptureTask>): void {
    const index = tasks.value.findIndex((task) => task.id === taskId)
    const current = tasks.value[index]
    if (index < 0 || !current) return
    tasks.value[index] = { ...current, ...patch }
  }

  function stopWatching(taskId: string): void {
    eventSources.get(taskId)?.close()
    eventSources.delete(taskId)
    const timer = pollTimers.get(taskId)
    if (timer !== undefined) window.clearTimeout(timer)
    pollTimers.delete(taskId)
  }

  function stopAllWatching(): void {
    for (const task of tasks.value) stopWatching(task.id)
  }

  function applyRun(taskId: string, run: RunManifest): void {
    updateTask(taskId, { run, status: run.status, error: run.error })
    if (terminalStatuses.has(run.status)) stopWatching(taskId)
  }

  async function readApiError(response: Response): Promise<string> {
    try {
      const payload = (await response.json()) as Partial<ApiErrorResponse>
      if (typeof payload.error === 'string') return payload.error
    } catch {
      // Use the fallback message when the server did not return JSON.
    }
    return '创建截图任务失败'
  }

  async function fetchRun(taskId: string, runId: string): Promise<void> {
    const response = await fetch(`/api/runs/${runId}`)
    if (!response.ok) throw new Error('无法获取截图任务')
    applyRun(taskId, (await response.json()) as RunManifest)
  }

  function startPolling(taskId: string, runId: string): void {
    stopWatching(taskId)
    const poll = async (): Promise<void> => {
      try {
        await fetchRun(taskId, runId)
        const task = findTask(taskId)
        if (!task || terminalStatuses.has(task.status)) return
      } catch {
        // A later poll may recover from a transient development-server restart.
      }
      pollTimers.set(
        taskId,
        window.setTimeout(() => void poll(), 1000),
      )
    }
    void poll()
  }

  function watchRun(taskId: string, runId: string): void {
    stopWatching(taskId)
    const eventSource = new EventSource(`/api/runs/${runId}/events`)
    eventSources.set(taskId, eventSource)
    eventSource.addEventListener('status', (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as RunEvent
      applyRun(taskId, event.run)
    })
    eventSource.onerror = () => {
      const task = findTask(taskId)
      if (task && !terminalStatuses.has(task.status)) startPolling(taskId, runId)
    }
  }

  function createRequest(
    url: string,
    preset: ViewportPreset,
    currentBatchId: string,
  ): CreateRunRequest {
    return {
      batchId: currentBatchId,
      outputName: preset.id,
      url,
      viewport: { ...preset.viewport },
      deviceScaleFactor: preset.deviceScaleFactor,
      isMobile: preset.isMobile,
      hasTouch: preset.hasTouch,
      fullPage: preset.fullPage,
      readySelector: preset.readySelector,
    }
  }

  async function createBatch(): Promise<string> {
    const response = await fetch('/api/batches', { method: 'POST' })
    if (!response.ok) throw new Error(await readApiError(response))
    const body = (await response.json()) as CreateBatchResponse
    return body.batch.batchId
  }

  async function launchTask(
    taskId: string,
    url: string,
    preset: ViewportPreset,
    currentBatchId: string,
  ): Promise<void> {
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRequest(url, preset, currentBatchId)),
      })
      if (!response.ok) throw new Error(await readApiError(response))
      const body = (await response.json()) as CreateRunResponse
      applyRun(taskId, body.run)
      watchRun(taskId, body.run.runId)
    } catch (error) {
      updateTask(taskId, {
        status: 'failed',
        error: error instanceof Error ? error.message : '创建截图任务失败',
      })
    }
  }

  async function startBatch(url: string, selectedPresetIds: string[]): Promise<void> {
    stopAllWatching()
    batchUrl.value = url
    batchId.value = ''
    const selectedIds = new Set(selectedPresetIds)
    tasks.value = viewportPresets.flatMap((platform) =>
      platform.presets.flatMap<CaptureTask>((preset) => {
        const taskId = getPresetSelectionId(platform.id, preset.id)
        if (!selectedIds.has(taskId)) return []
        return [
          {
            id: taskId,
            platformId: platform.id,
            preset,
            status: 'queued',
            run: null,
            error: null,
          },
        ]
      }),
    )

    try {
      batchId.value = await createBatch()
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建批次失败'
      for (const task of tasks.value) updateTask(task.id, { status: 'failed', error: message })
      return
    }

    await Promise.all(
      tasks.value.map((task) => launchTask(task.id, url, task.preset, batchId.value)),
    )
  }

  async function retryTask(taskId: string): Promise<void> {
    const task = findTask(taskId)
    if (!task || task.status !== 'failed' || !batchUrl.value || !batchId.value) return
    stopWatching(taskId)
    updateTask(taskId, { status: 'queued', run: null, error: null })
    await launchTask(taskId, batchUrl.value, task.preset, batchId.value)
  }

  return {
    tasks,
    batchUrl,
    batchId,
    totalCount,
    completedCount,
    progressPercentage,
    isRunning,
    platformProgress,
    startBatch,
    retryTask,
  }
})
