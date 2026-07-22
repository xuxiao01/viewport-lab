import type {
  ApiErrorResponse,
  BatchManifest,
  BatchStatus,
  BatchSummary,
  CaptureDelayMs,
  CreateBatchRequest,
  CreateBatchResponse,
  CreateRunRequest,
  CreateRunResponse,
  ListBatchesResponse,
  RunEvent,
  RunManifest,
  RunStatus,
  ScreenshotComparisonSelection,
  ScreenshotDevicePresetSnapshot,
  ScreenshotDeviceRun,
} from '@viewport-lab/shared'
import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'

import { getPresetSelectionId, viewportPresets } from '../config/viewport-presets'
import type {
  CaptureTask,
  PlatformId,
  PlatformCaptureStatus,
  PlatformProgressItem,
  ViewportPreset,
} from '../types/capture'

const terminalStatuses = new Set<RunStatus>(['completed', 'failed'])
const terminalBatchStatuses = new Set<BatchStatus>(['completed', 'partial_failed', 'failed'])

function toBatchSummary(batch: BatchManifest): BatchSummary {
  const {
    batchId,
    createdAt,
    completedAt,
    url,
    note,
    captureDelayMs,
    status,
    durationMs,
    deviceCount,
    successCount,
    failedCount,
  } = batch
  return {
    batchId,
    createdAt,
    completedAt,
    url,
    note,
    captureDelayMs: captureDelayMs ?? 0,
    status,
    durationMs,
    deviceCount,
    successCount,
    failedCount,
  }
}

function aggregateBatch(batch: BatchManifest, updatedAt: string): BatchManifest {
  const successCount = batch.devices.filter((device) => device.status === 'completed').length
  const failedCount = batch.devices.filter((device) => device.status === 'failed').length
  const terminalCount = successCount + failedCount
  let status: BatchStatus = 'running'
  if (batch.devices.every((device) => device.status === 'queued')) status = 'queued'
  if (terminalCount === batch.deviceCount) {
    if (failedCount === 0) status = 'completed'
    else if (successCount === 0) status = 'failed'
    else status = 'partial_failed'
  }
  const completedAt = terminalBatchStatuses.has(status) ? (batch.completedAt ?? updatedAt) : null
  return {
    ...batch,
    updatedAt,
    completedAt,
    status,
    durationMs: completedAt
      ? Math.max(0, new Date(completedAt).getTime() - new Date(batch.createdAt).getTime())
      : null,
    successCount,
    failedCount,
  }
}

function runFromDevice(batch: BatchManifest, device: ScreenshotDeviceRun): RunManifest | null {
  if (!device.runId) return null
  return {
    runId: device.runId,
    request: {
      batchId: batch.batchId,
      selectionId: device.selectionId,
      outputName: device.presetId,
      url: batch.url,
      viewport: device.viewport,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      fullPage: device.fullPage,
      readySelector: device.readySelector,
      captureDelayMs: device.captureDelayMs ?? batch.captureDelayMs ?? 0,
    },
    status: device.status,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    completedAt: device.completedAt,
    screenshotPath: device.screenshotPath,
    screenshotUrl: device.screenshotUrl,
    error: device.error,
  }
}

function taskFromDevice(batch: BatchManifest, device: ScreenshotDeviceRun): CaptureTask {
  return {
    id: device.selectionId,
    platformId: device.platformId,
    preset: {
      id: device.presetId,
      name: device.presetName,
      description: '',
      representativeModels: [],
      viewport: device.viewport,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      fullPage: device.fullPage,
      readySelector: device.readySelector,
    },
    status: device.status,
    run: runFromDevice(batch, device),
    error: device.error,
  }
}

function normalizeDeviceSnapshot(
  device: ScreenshotDevicePresetSnapshot | ScreenshotDeviceRun,
  captureDelayMs: CaptureDelayMs,
): ScreenshotDevicePresetSnapshot {
  return {
    selectionId: device.selectionId,
    platformId: device.platformId,
    platformName: device.platformName,
    presetId: device.presetId,
    presetName: device.presetName,
    viewport: { ...device.viewport },
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
    fullPage: device.fullPage,
    readySelector: device.readySelector,
    captureDelayMs: device.captureDelayMs ?? captureDelayMs,
  }
}

function queuedTaskFromSnapshot(device: ScreenshotDevicePresetSnapshot): CaptureTask {
  return {
    id: device.selectionId,
    platformId: device.platformId,
    preset: {
      id: device.presetId,
      name: device.presetName,
      description: '',
      representativeModels: [],
      viewport: { ...device.viewport },
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      fullPage: device.fullPage,
      readySelector: device.readySelector,
    },
    status: 'queued',
    run: null,
    error: null,
  }
}

export const useRunStore = defineStore('run', () => {
  const tasks = ref<CaptureTask[]>([])
  const batchUrl = ref('')
  const batchId = ref('')
  const batchCaptureDelayMs = ref<CaptureDelayMs>(0)
  const currentBatch = ref<BatchManifest | null>(null)
  const batchHistory = ref<BatchSummary[]>([])
  const selectedBatchId = ref<string | null>(null)
  const selectedBatch = ref<BatchManifest | null>(null)
  const historyLoading = ref(false)
  const detailLoading = ref(false)
  const historyError = ref<string | null>(null)
  const comparison = ref<ScreenshotComparisonSelection>({
    baselineBatchId: null,
    comparisonBatchId: null,
  })
  const eventSources = new Map<string, EventSource>()
  const pollTimers = new Map<string, number>()
  const finalizingBatches = new Set<string>()

  const totalCount = computed(() => tasks.value.length)
  const completedCount = computed(
    () => tasks.value.filter((task) => terminalStatuses.has(task.status)).length,
  )
  const progressPercentage = computed(() =>
    totalCount.value === 0 ? 0 : Math.round((completedCount.value / totalCount.value) * 100),
  )
  const isRunning = computed(() => tasks.value.some((task) => !terminalStatuses.has(task.status)))
  const selectedTasks = computed(() =>
    selectedBatch.value
      ? selectedBatch.value.devices.map((device) => taskFromDevice(selectedBatch.value!, device))
      : [],
  )
  const canRetrySelectedBatch = computed(
    () => selectedBatchId.value !== null && selectedBatchId.value === batchId.value,
  )
  const comparisonCandidates = computed(() =>
    batchHistory.value.filter(
      (batch) => terminalBatchStatuses.has(batch.status) && batch.successCount > 0,
    ),
  )
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

  function upsertSummary(batch: BatchManifest): void {
    const summary = toBatchSummary(batch)
    batchHistory.value = [
      summary,
      ...batchHistory.value.filter((item) => item.batchId !== summary.batchId),
    ].sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  function syncCurrentBatch(run: RunManifest): void {
    const batch = currentBatch.value
    if (!batch || batch.batchId !== run.request.batchId) return
    const index = batch.devices.findIndex(
      (device) => device.selectionId === run.request.selectionId,
    )
    if (index < 0) return
    const devices = [...batch.devices]
    devices[index] = {
      ...devices[index]!,
      runId: run.runId,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      completedAt: run.completedAt,
      screenshotPath: run.screenshotPath,
      screenshotUrl: run.screenshotUrl,
      error: run.error,
    }
    const updated = aggregateBatch({ ...batch, devices, completedAt: null }, run.updatedAt)
    currentBatch.value = updated
    if (selectedBatchId.value === updated.batchId) selectedBatch.value = updated
    upsertSummary(updated)
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

  async function fetchBatchDetail(id: string): Promise<BatchManifest> {
    const response = await fetch(`/api/batches/${id}`)
    if (!response.ok) throw new Error(await readApiError(response, '无法获取截图批次'))
    return (await response.json()) as BatchManifest
  }

  async function finalizeCurrentBatch(id: string): Promise<void> {
    if (finalizingBatches.has(id)) return
    finalizingBatches.add(id)
    try {
      const batch = await fetchBatchDetail(id)
      if (batchId.value === id) currentBatch.value = batch
      if (selectedBatchId.value === id) selectedBatch.value = batch
      upsertSummary(batch)
    } catch {
      // The live task cards already contain the final result; history can recover on refresh.
    } finally {
      finalizingBatches.delete(id)
    }
  }

  function applyRun(taskId: string, run: RunManifest): void {
    updateTask(taskId, { run, status: run.status, error: run.error })
    syncCurrentBatch(run)
    if (terminalStatuses.has(run.status)) stopWatching(taskId)
    if (tasks.value.length > 0 && tasks.value.every((task) => terminalStatuses.has(task.status))) {
      void finalizeCurrentBatch(run.request.batchId)
    }
  }

  async function readApiError(response: Response, fallback: string): Promise<string> {
    try {
      const payload = (await response.json()) as Partial<ApiErrorResponse>
      if (typeof payload.error === 'string') return payload.error
    } catch {
      // Use the supplied fallback when the server did not return JSON.
    }
    return fallback
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
    taskId: string,
    currentBatchId: string,
    captureDelayMs: CaptureDelayMs,
  ): CreateRunRequest {
    return {
      batchId: currentBatchId,
      selectionId: taskId,
      outputName: preset.id,
      url,
      viewport: { ...preset.viewport },
      deviceScaleFactor: preset.deviceScaleFactor,
      isMobile: preset.isMobile,
      hasTouch: preset.hasTouch,
      fullPage: preset.fullPage,
      readySelector: preset.readySelector,
      captureDelayMs,
    }
  }

  function createPresetSnapshot(
    platformId: PlatformId,
    platformName: string,
    preset: ViewportPreset,
    captureDelayMs: CaptureDelayMs,
  ): ScreenshotDevicePresetSnapshot {
    return {
      selectionId: getPresetSelectionId(platformId, preset.id),
      platformId,
      platformName,
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

  async function createBatch(
    url: string,
    note: string,
    captureDelayMs: CaptureDelayMs,
    devices: ScreenshotDevicePresetSnapshot[],
  ): Promise<BatchManifest> {
    const payload: CreateBatchRequest = {
      url,
      note,
      captureDelayMs,
      devices,
    }
    const response = await fetch('/api/batches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) throw new Error(await readApiError(response, '创建截图批次失败'))
    return ((await response.json()) as CreateBatchResponse).batch
  }

  async function launchTask(
    taskId: string,
    url: string,
    preset: ViewportPreset,
    currentBatchId: string,
    captureDelayMs: CaptureDelayMs,
  ): Promise<void> {
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(createRequest(url, preset, taskId, currentBatchId, captureDelayMs)),
      })
      if (!response.ok) throw new Error(await readApiError(response, '创建截图任务失败'))
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

  async function startBatchFromSnapshots(
    url: string,
    note: string,
    captureDelayMs: CaptureDelayMs,
    devices: ScreenshotDevicePresetSnapshot[],
  ): Promise<void> {
    if (isRunning.value) throw new Error('当前已有截图批次正在运行')
    if (devices.length === 0) throw new Error('截图批次至少需要一个设备预设')

    stopAllWatching()
    batchUrl.value = url
    batchId.value = ''
    batchCaptureDelayMs.value = captureDelayMs
    currentBatch.value = null
    const normalizedDevices = devices.map((device) =>
      normalizeDeviceSnapshot(device, captureDelayMs),
    )
    tasks.value = normalizedDevices.map(queuedTaskFromSnapshot)

    try {
      const batch = await createBatch(url, note, captureDelayMs, normalizedDevices)
      batchId.value = batch.batchId
      currentBatch.value = batch
      selectedBatchId.value = batch.batchId
      selectedBatch.value = batch
      upsertSummary(batch)
    } catch (error) {
      const message = error instanceof Error ? error.message : '创建批次失败'
      for (const task of tasks.value) updateTask(task.id, { status: 'failed', error: message })
      throw error
    }

    await Promise.all(
      tasks.value.map((task) =>
        launchTask(task.id, url, task.preset, batchId.value, captureDelayMs),
      ),
    )
  }

  async function startBatch(
    url: string,
    note: string,
    selectedPresetIds: string[],
    captureDelayMs: CaptureDelayMs,
  ): Promise<void> {
    const selectedIds = new Set(selectedPresetIds)
    const devices = viewportPresets.flatMap((platform) =>
      platform.presets.flatMap<ScreenshotDevicePresetSnapshot>((preset) => {
        const selectionId = getPresetSelectionId(platform.id, preset.id)
        if (!selectedIds.has(selectionId)) return []
        return [createPresetSnapshot(platform.id, platform.name, preset, captureDelayMs)]
      }),
    )
    await startBatchFromSnapshots(url, note, captureDelayMs, devices)
  }

  async function rerunBatch(id: string): Promise<void> {
    if (isRunning.value) throw new Error('当前已有截图批次正在运行')
    const sourceBatch = await fetchBatchDetail(id)
    if (!terminalBatchStatuses.has(sourceBatch.status)) {
      throw new Error('只能重跑已结束的截图批次')
    }
    const captureDelayMs = sourceBatch.captureDelayMs ?? 0
    const devices = sourceBatch.devices.map((device) =>
      normalizeDeviceSnapshot(device, captureDelayMs),
    )
    await startBatchFromSnapshots(sourceBatch.url, sourceBatch.note, captureDelayMs, devices)
  }

  async function retryTask(taskId: string): Promise<void> {
    const task = findTask(taskId)
    if (!task || task.status !== 'failed' || !batchUrl.value || !batchId.value) return
    stopWatching(taskId)
    updateTask(taskId, { status: 'queued', run: null, error: null })
    await launchTask(
      taskId,
      batchUrl.value,
      task.preset,
      batchId.value,
      currentBatch.value?.captureDelayMs ?? batchCaptureDelayMs.value,
    )
  }

  async function loadHistory(): Promise<void> {
    historyLoading.value = true
    historyError.value = null
    try {
      const response = await fetch('/api/batches')
      if (!response.ok) throw new Error(await readApiError(response, '无法加载截图历史'))
      batchHistory.value = ((await response.json()) as ListBatchesResponse).batches
      if (!selectedBatchId.value && batchHistory.value[0]) {
        await selectBatch(batchHistory.value[0].batchId)
      }
    } catch (error) {
      historyError.value = error instanceof Error ? error.message : '无法加载截图历史'
    } finally {
      historyLoading.value = false
    }
  }

  async function selectBatch(id: string): Promise<void> {
    selectedBatchId.value = id
    historyError.value = null
    if (currentBatch.value?.batchId === id) {
      selectedBatch.value = currentBatch.value
      return
    }
    detailLoading.value = true
    try {
      const batch = await fetchBatchDetail(id)
      if (selectedBatchId.value === id) selectedBatch.value = batch
    } catch (error) {
      if (selectedBatchId.value === id) {
        selectedBatch.value = null
        historyError.value = error instanceof Error ? error.message : '无法加载批次详情'
      }
    } finally {
      if (selectedBatchId.value === id) detailLoading.value = false
    }
  }

  async function deleteBatch(id: string): Promise<void> {
    const response = await fetch(`/api/batches/${id}`, { method: 'DELETE' })
    if (!response.ok) throw new Error(await readApiError(response, '删除截图批次失败'))
    const deletedIndex = batchHistory.value.findIndex((batch) => batch.batchId === id)
    batchHistory.value = batchHistory.value.filter((batch) => batch.batchId !== id)
    if (comparison.value.baselineBatchId === id) comparison.value.baselineBatchId = null
    if (comparison.value.comparisonBatchId === id) comparison.value.comparisonBatchId = null
    if (selectedBatchId.value !== id) return
    const fallback = batchHistory.value[Math.max(0, deletedIndex - 1)] ?? batchHistory.value[0]
    selectedBatchId.value = null
    selectedBatch.value = null
    if (fallback) await selectBatch(fallback.batchId)
  }

  function setBaselineBatch(id: string | null): void {
    comparison.value.baselineBatchId = id
    if (id && comparison.value.comparisonBatchId === id) {
      comparison.value.comparisonBatchId = null
    }
  }

  function setComparisonBatch(id: string | null): void {
    comparison.value.comparisonBatchId = id
    if (id && comparison.value.baselineBatchId === id) comparison.value.baselineBatchId = null
  }

  return {
    tasks,
    batchUrl,
    batchId,
    currentBatch,
    batchHistory,
    selectedBatchId,
    selectedBatch,
    selectedTasks,
    historyLoading,
    detailLoading,
    historyError,
    comparison,
    comparisonCandidates,
    canRetrySelectedBatch,
    totalCount,
    completedCount,
    progressPercentage,
    isRunning,
    platformProgress,
    startBatch,
    rerunBatch,
    retryTask,
    loadHistory,
    selectBatch,
    deleteBatch,
    setBaselineBatch,
    setComparisonBatch,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useRunStore, import.meta.hot))
}
