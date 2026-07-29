<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import type {
  CaptureDelayMs,
  DeviceAgentRun,
  RerunScope,
  RunKind,
  TestConfiguration,
} from '@viewport-lab/shared'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

import AgentScreenshotViewer from '../components/AgentScreenshotViewer.vue'
import AgentStepViewer from '../components/AgentStepViewer.vue'
import AppHeader from '../components/AppHeader.vue'
import CapturePanel from '../components/CapturePanel.vue'
import CaptureProgress from '../components/CaptureProgress.vue'
import ScreenshotHistory from '../components/ScreenshotHistory.vue'
import ScreenshotViewer from '../components/ScreenshotViewer.vue'
import {
  defaultSelectedPresetIds,
  getPlatformPresetIds,
  viewportPresets,
} from '../config/viewport-presets'
import { useRunStore } from '../stores/run'
import { useAgentStore } from '../stores/agent'
import { useTestConfigurationStore } from '../stores/test-configurations'
import type { CaptureTask, PlatformId } from '../types/capture'
import { loadTaskDraft, saveTaskDraft, type TaskDraft } from '../utils/task-draft'

const store = useRunStore()
const agentStore = useAgentStore()
const configurationStore = useTestConfigurationStore()
const route = useRoute()
const router = useRouter()
const initialDraft = loadTaskDraft({
  url: 'http://localhost:5188',
  note: '',
  aiTaskDescription: '',
  maxTurns: 50,
  captureDelayMs: 0,
  selectedCategories: ['ios-phone'],
  activeCategory: 'ios-phone',
  selectedPresetIds: [...defaultSelectedPresetIds],
  initializedCategories: ['ios-phone'],
})
const url = ref(initialDraft.url)
const note = ref(initialDraft.note)
const aiTaskDescription = ref(initialDraft.aiTaskDescription)
const maxTurns = ref(initialDraft.maxTurns)
const captureDelayMs = ref<CaptureDelayMs>(initialDraft.captureDelayMs)
const selectedCategories = ref<PlatformId[]>([...initialDraft.selectedCategories])
const activeCategory = ref<PlatformId | null>(initialDraft.activeCategory)
const selectedPresetIds = ref<string[]>([...initialDraft.selectedPresetIds])
const initializedCategories = ref<PlatformId[]>([...initialDraft.initializedCategories])
const viewerVisible = ref(false)
const viewerTask = ref<CaptureTask | null>(null)
const selectedKind = ref<'viewport' | 'agent'>('viewport')
const agentViewerVisible = ref(false)
const agentStepViewerVisible = ref(false)
const selectedAgentDevice = ref<DeviceAgentRun | null>(null)
const isAgentMode = computed(() => aiTaskDescription.value.trim().length > 0)
const taskSubmitting = computed(() => store.creating || agentStore.creating)
const selectedViewportRunning = computed(
  () =>
    selectedKind.value === 'viewport' &&
    (store.selectedBatch?.status === 'queued' || store.selectedBatch?.status === 'running'),
)

watch(
  [
    url,
    note,
    aiTaskDescription,
    maxTurns,
    captureDelayMs,
    selectedCategories,
    activeCategory,
    selectedPresetIds,
    initializedCategories,
  ],
  () => {
    const draft: TaskDraft = {
      url: url.value,
      note: note.value,
      aiTaskDescription: aiTaskDescription.value,
      maxTurns: maxTurns.value,
      captureDelayMs: captureDelayMs.value,
      selectedCategories: [...selectedCategories.value],
      activeCategory: activeCategory.value,
      selectedPresetIds: [...selectedPresetIds.value],
      initializedCategories: [...initializedCategories.value],
    }
    saveTaskDraft(draft)
  },
  { deep: true, flush: 'sync', immediate: true },
)

const effectiveSelectedPresetIds = computed(() =>
  viewportPresets.flatMap((platform) => {
    if (!selectedCategories.value.includes(platform.id)) return []
    return getPlatformPresetIds(platform).filter((id) => selectedPresetIds.value.includes(id))
  }),
)

const resultPlatforms = computed(() =>
  viewportPresets.filter((platform) =>
    store.selectedTasks.some((task) => task.platformId === platform.id),
  ),
)

async function startDetectionTask(): Promise<void> {
  if (taskSubmitting.value) return
  if (isAgentMode.value) {
    if (!agentStore.gatewayStatus?.configured) {
      ElMessage.error(agentStore.gatewayStatus?.reason ?? 'AI 网关未配置')
      return
    }
    const run = await agentStore.createRun({
      url: url.value.trim(),
      task: aiTaskDescription.value.trim(),
      note: note.value.trim(),
      selectedPresetIds: effectiveSelectedPresetIds.value,
      maxTurns: maxTurns.value,
    })
    if (!run) {
      ElMessage.error(agentStore.error ?? '创建 Agent 运行失败')
      return
    }
    selectedKind.value = 'agent'
    await router.replace({ query: { kind: 'agent', runId: run.runId } })
    await nextTick()
    document.querySelector('.history-section')?.scrollIntoView({ behavior: 'smooth' })
    return
  }

  try {
    await store.startBatch(
      url.value.trim(),
      note.value.trim(),
      effectiveSelectedPresetIds.value,
      captureDelayMs.value,
    )
    selectedKind.value = 'viewport'
    if (store.selectedBatchId) {
      await router.replace({
        query: { kind: 'viewport', runId: store.selectedBatchId },
      })
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '创建截图批次失败')
  }
}

function applyConfiguration(configuration: TestConfiguration): void {
  url.value = configuration.url
  note.value = configuration.note
  aiTaskDescription.value = configuration.kind === 'agent' ? configuration.task : ''
  maxTurns.value = configuration.kind === 'agent' ? configuration.maxTurns : 50
  captureDelayMs.value = configuration.kind === 'viewport' ? configuration.captureDelayMs : 0

  const platformIds = [...new Set(configuration.devices.map((device) => device.platformId))]
  selectedCategories.value = orderCategories(platformIds)
  initializedCategories.value = [...selectedCategories.value]
  activeCategory.value = selectedCategories.value[0] ?? null
  selectedPresetIds.value = configuration.devices.map((device) => device.selectionId)
}

async function executeConfiguration(configuration: TestConfiguration): Promise<void> {
  if (taskSubmitting.value) {
    ElMessage.error('正在提交检测任务，请稍候')
    return
  }
  if (configuration.kind === 'agent') {
    if (!agentStore.gatewayStatus?.configured) {
      ElMessage.error(agentStore.gatewayStatus?.reason ?? 'AI 网关未配置')
      return
    }
    const run = await agentStore.createRunFromSnapshots({
      url: configuration.url,
      task: configuration.task,
      note: configuration.note,
      devices: configuration.devices,
      maxTurns: configuration.maxTurns,
    })
    if (!run) {
      ElMessage.error(agentStore.error ?? '创建 Agent 运行失败')
      return
    }
    selectedKind.value = 'agent'
    await router.replace({ query: { kind: 'agent', runId: run.runId } })
  } else {
    try {
      await store.startBatchFromSnapshots(
        configuration.url,
        configuration.note,
        configuration.captureDelayMs,
        configuration.devices,
      )
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '创建截图批次失败')
      return
    }
    selectedKind.value = 'viewport'
    if (store.selectedBatchId) {
      await router.replace({
        query: { kind: 'viewport', runId: store.selectedBatchId },
      })
    }
  }
  await nextTick()
  document.querySelector('.history-section')?.scrollIntoView({ behavior: 'smooth' })
}

function orderCategories(categoryIds: PlatformId[]): PlatformId[] {
  return viewportPresets
    .filter((platform) => categoryIds.includes(platform.id))
    .map((platform) => platform.id)
}

function toggleCategory(platformId: PlatformId): void {
  if (selectedCategories.value.includes(platformId)) {
    selectedCategories.value = selectedCategories.value.filter((id) => id !== platformId)
    if (activeCategory.value === platformId) {
      activeCategory.value = orderCategories(selectedCategories.value)[0] ?? null
    }
    return
  }

  if (!initializedCategories.value.includes(platformId)) {
    const platform = viewportPresets.find((item) => item.id === platformId)
    if (platform) {
      const platformPresetIds = getPlatformPresetIds(platform)
      const otherPresetIds = selectedPresetIds.value.filter((id) => !platformPresetIds.includes(id))
      selectedPresetIds.value = [...otherPresetIds, ...platformPresetIds]
    }
    initializedCategories.value = [...initializedCategories.value, platformId]
  }

  selectedCategories.value = orderCategories([...selectedCategories.value, platformId])
  activeCategory.value = platformId
}

function updateActiveCategory(platformId: PlatformId): void {
  if (selectedCategories.value.includes(platformId)) activeCategory.value = platformId
}

function viewScreenshot(task: CaptureTask): void {
  viewerTask.value = task
  viewerVisible.value = true
}

async function deleteBatch(batchId: string): Promise<void> {
  try {
    await store.deleteBatch(batchId)
    if (viewerTask.value?.run?.request.batchId === batchId) viewerVisible.value = false
    ElMessage.success('截图批次已删除')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除截图批次失败')
  }
}

async function selectViewportBatch(batchId: string): Promise<void> {
  selectedKind.value = 'viewport'
  await store.selectBatch(batchId)
  await router.replace({ query: { kind: 'viewport', runId: batchId } })
}

async function selectAgentRun(runId: string): Promise<void> {
  selectedKind.value = 'agent'
  await agentStore.selectRun(runId)
  await router.replace({ query: { kind: 'agent', runId } })
}

async function deleteAgentRun(runId: string): Promise<void> {
  try {
    await agentStore.deleteRun(runId)
    const fallback = store.batchHistory[0]
    if (fallback) await selectViewportBatch(fallback.batchId)
    else if (agentStore.runHistory[0]) await selectAgentRun(agentStore.runHistory[0].runId)
    ElMessage.success('Agent 批次已删除')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除 Agent 批次失败')
  }
}

async function updateTaskTitle(
  kind: RunKind,
  runId: string,
  title: string,
  settled: (success: boolean) => void,
): Promise<void> {
  try {
    if (kind === 'agent') await agentStore.updateRunNote(runId, title)
    else await store.updateBatchNote(runId, title)
    settled(true)
    ElMessage.success('任务标题已修改')
  } catch (error) {
    settled(false)
    ElMessage.error(error instanceof Error ? error.message : '修改任务标题失败')
  }
}

function viewAgentScreenshot(device: DeviceAgentRun): void {
  selectedAgentDevice.value = device
  agentViewerVisible.value = true
}

function viewAgentSteps(device: DeviceAgentRun): void {
  selectedAgentDevice.value = device
  agentStepViewerVisible.value = true
}

async function rerunBatch(batchId: string, scope: RerunScope): Promise<void> {
  try {
    await store.rerunBatch(batchId, scope)
    ElMessage.success(scope === 'failed' ? '正在原批次中重跑失败设备' : '正在原批次中重跑全部设备')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '重跑截图批次失败')
  }
}

async function rerunAgentRun(runId: string, scope: RerunScope): Promise<void> {
  const run = await agentStore.rerunRun(runId, scope)
  if (!run) {
    ElMessage.error(agentStore.error ?? '重跑 Agent 批次失败')
    return
  }

  selectedKind.value = 'agent'
  await router.replace({ query: { kind: 'agent', runId: run.runId } })
  await nextTick()
  document.querySelector('.history-section')?.scrollIntoView({ behavior: 'smooth' })
  ElMessage.success(
    scope === 'failed'
      ? '正在原批次中重跑失败设备'
      : scope === 'list'
        ? '正在原批次中重跑清单设备'
        : '正在原批次中重跑全部设备',
  )
}

async function toggleAgentRerunList(device: DeviceAgentRun, included: boolean): Promise<void> {
  try {
    await agentStore.updateRerunList(device.deviceId, included)
    ElMessage.success(included ? '已加入重跑清单' : '已移出重跑清单')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '更新重跑清单失败')
  }
}

function defaultConfigurationName(kind: RunKind): string {
  const source = kind === 'viewport' ? store.selectedBatch : agentStore.currentRun
  if (source?.note.trim()) return source.note.trim()
  try {
    return `${new URL(source?.url ?? url.value).hostname} · ${
      kind === 'agent' ? 'Agent 探索' : '视口截图'
    }`
  } catch {
    return kind === 'agent' ? 'Agent 探索配置' : '视口截图配置'
  }
}

async function addConfiguration(kind: RunKind, sourceRunId: string): Promise<void> {
  let name: string
  try {
    const result = await ElMessageBox.prompt(
      '为这套测试参数填写一个便于识别的名称。',
      '加入配置清单',
      {
        confirmButtonText: '保存配置',
        cancelButtonText: '取消',
        inputValue: defaultConfigurationName(kind),
        inputPlaceholder: '例如：首页移动端回归检查',
        inputValidator: (value) => {
          const normalized = value.trim()
          if (!normalized) return '请输入配置名称'
          if (normalized.length > 200) return '配置名称不能超过 200 字'
          return true
        },
      },
    )
    name = result.value.trim()
  } catch {
    return
  }

  try {
    const result = await configurationStore.saveConfiguration(kind, sourceRunId, name)
    ElMessage.success(result.created ? '已加入配置清单' : '该批次已在配置清单中')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '加入配置清单失败')
  }
}

onMounted(async () => {
  await Promise.all([
    store.loadHistory(),
    agentStore.loadHistory(),
    agentStore.loadGatewayStatus(),
    configurationStore.loadConfigurations(),
  ])
  const requestedConfigurationId = route.query.configurationId
  if (typeof requestedConfigurationId === 'string' && route.query.autorun === '1') {
    try {
      const configuration = await configurationStore.getConfiguration(requestedConfigurationId)
      applyConfiguration(configuration)
      await router.replace({ name: 'home' })
      await nextTick()
      await executeConfiguration(configuration)
    } catch (error) {
      await router.replace({ name: 'home' })
      ElMessage.error(error instanceof Error ? error.message : '无法重跑测试配置')
    }
    return
  }
  const requestedKind = route.query.kind
  const requestedId = route.query.runId
  if (requestedKind === 'agent' && typeof requestedId === 'string') {
    await selectAgentRun(requestedId)
    await nextTick()
    document.querySelector('.history-section')?.scrollIntoView({ behavior: 'smooth' })
  } else if (requestedKind === 'viewport' && typeof requestedId === 'string') {
    await selectViewportBatch(requestedId)
    await nextTick()
    document.querySelector('.history-section')?.scrollIntoView({ behavior: 'smooth' })
  }
})
</script>

<template>
  <main class="page-shell">
    <AppHeader />
    <div class="page-content">
      <CapturePanel
        :url="url"
        :note="note"
        :ai-task-description="aiTaskDescription"
        :max-turns="maxTurns"
        :capture-delay-ms="captureDelayMs"
        :gateway-status="agentStore.gatewayStatus"
        :selected-categories="selectedCategories"
        :active-category="activeCategory"
        :selected-preset-ids="selectedPresetIds"
        :platforms="viewportPresets"
        :running="taskSubmitting"
        @update:url="url = $event"
        @update:note="note = $event"
        @update:ai-task-description="aiTaskDescription = $event"
        @update:max-turns="maxTurns = $event"
        @update:capture-delay-ms="captureDelayMs = $event"
        @update:active-category="updateActiveCategory"
        @update:selected-preset-ids="selectedPresetIds = $event"
        @toggle-category="toggleCategory"
        @start="startDetectionTask"
      />
      <CaptureProgress
        v-if="selectedKind === 'viewport'"
        :completed="store.completedCount"
        :total="store.totalCount"
        :percentage="store.progressPercentage"
        :platforms="store.platformProgress"
      />
      <ScreenshotHistory
        :history="store.batchHistory"
        :agent-history="agentStore.runHistory"
        :selected-batch-id="store.selectedBatchId"
        :selected-kind="selectedKind"
        :batch="store.selectedBatch"
        :agent-run="agentStore.currentRun"
        :platforms="resultPlatforms"
        :tasks="store.selectedTasks"
        :loading="store.historyLoading || agentStore.historyLoading"
        :detail-loading="selectedKind === 'agent' ? agentStore.detailLoading : store.detailLoading"
        :error="store.historyError ?? agentStore.error"
        :retryable="store.canRetrySelectedBatch"
        :running="selectedViewportRunning"
        :agent-rerunning="agentStore.rerunning"
        :agent-rerun-list-updating-device-id="agentStore.rerunListUpdatingDeviceId"
        :saved-configuration-source-keys="configurationStore.savedSourceKeys"
        :configuration-saving-source-key="configurationStore.savingSourceKey"
        :comparison-candidates="store.comparisonCandidates"
        :baseline-batch-id="store.comparison.baselineBatchId"
        :comparison-batch-id="store.comparison.comparisonBatchId"
        @select="selectViewportBatch"
        @select-agent="selectAgentRun"
        @delete="deleteBatch"
        @delete-agent="deleteAgentRun"
        @rerun="rerunBatch"
        @rerun-agent="rerunAgentRun"
        @toggle-agent-rerun-list="toggleAgentRerunList"
        @update-title="updateTaskTitle"
        @add-configuration="addConfiguration"
        @view="viewScreenshot"
        @retry="store.retryTask"
        @view-agent="viewAgentScreenshot"
        @view-agent-steps="viewAgentSteps"
        @update:baseline-batch-id="store.setBaselineBatch"
        @update:comparison-batch-id="store.setComparisonBatch"
      />
    </div>
    <ScreenshotViewer v-model="viewerVisible" :task="viewerTask" />
    <AgentScreenshotViewer
      v-model="agentViewerVisible"
      :run="agentStore.currentRun"
      :device="selectedAgentDevice"
    />
    <AgentStepViewer
      v-model="agentStepViewerVisible"
      :run="agentStore.currentRun"
      :initial-device-id="selectedAgentDevice?.deviceId ?? null"
    />
  </main>
</template>

<style scoped>
.page-shell {
  width: min(1440px, calc(100% - 48px));
  margin: 0 auto;
  padding-bottom: 64px;
}

.page-content {
  display: grid;
  gap: 18px;
}

@media (max-width: 720px) {
  .page-shell {
    width: min(100% - 24px, 640px);
    padding-bottom: 36px;
  }
}
</style>
