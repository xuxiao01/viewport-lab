<script setup lang="ts">
import { ElMessage } from 'element-plus'
import type { CaptureDelayMs } from '@viewport-lab/shared'
import { computed, onMounted, ref } from 'vue'

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
import type { CaptureTask, PlatformId } from '../types/capture'

const store = useRunStore()
const url = ref('http://localhost:5188')
const note = ref('')
const captureDelayMs = ref<CaptureDelayMs>(0)
const selectedCategories = ref<PlatformId[]>(['ios-phone'])
const activeCategory = ref<PlatformId | null>('ios-phone')
const selectedPresetIds = ref<string[]>([...defaultSelectedPresetIds])
const initializedCategories = ref<PlatformId[]>(['ios-phone'])
const viewerVisible = ref(false)
const viewerTask = ref<CaptureTask | null>(null)

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

async function startBatch(): Promise<void> {
  await store.startBatch(
    url.value.trim(),
    note.value.trim(),
    effectiveSelectedPresetIds.value,
    captureDelayMs.value,
  )
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

onMounted(() => {
  void store.loadHistory()
})
</script>

<template>
  <main class="page-shell">
    <AppHeader />
    <div class="page-content">
      <CapturePanel
        :url="url"
        :note="note"
        :capture-delay-ms="captureDelayMs"
        :selected-categories="selectedCategories"
        :active-category="activeCategory"
        :selected-preset-ids="selectedPresetIds"
        :platforms="viewportPresets"
        :running="store.isRunning"
        @update:url="url = $event"
        @update:note="note = $event"
        @update:capture-delay-ms="captureDelayMs = $event"
        @update:active-category="updateActiveCategory"
        @update:selected-preset-ids="selectedPresetIds = $event"
        @toggle-category="toggleCategory"
        @start="startBatch"
      />
      <CaptureProgress
        :completed="store.completedCount"
        :total="store.totalCount"
        :percentage="store.progressPercentage"
        :platforms="store.platformProgress"
      />
      <ScreenshotHistory
        :history="store.batchHistory"
        :selected-batch-id="store.selectedBatchId"
        :batch="store.selectedBatch"
        :platforms="resultPlatforms"
        :tasks="store.selectedTasks"
        :loading="store.historyLoading"
        :detail-loading="store.detailLoading"
        :error="store.historyError"
        :retryable="store.canRetrySelectedBatch"
        :comparison-candidates="store.comparisonCandidates"
        :baseline-batch-id="store.comparison.baselineBatchId"
        :comparison-batch-id="store.comparison.comparisonBatchId"
        @select="store.selectBatch"
        @delete="deleteBatch"
        @view="viewScreenshot"
        @retry="store.retryTask"
        @update:baseline-batch-id="store.setBaselineBatch"
        @update:comparison-batch-id="store.setComparisonBatch"
      />
    </div>
    <ScreenshotViewer v-model="viewerVisible" :task="viewerTask" />
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
