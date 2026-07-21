<script setup lang="ts">
import { computed, ref } from 'vue'

import AppHeader from '../components/AppHeader.vue'
import CapturePanel from '../components/CapturePanel.vue'
import CaptureProgress from '../components/CaptureProgress.vue'
import ResultAccordion from '../components/ResultAccordion.vue'
import ScreenshotViewer from '../components/ScreenshotViewer.vue'
import { defaultSelectedPresetIds, viewportPresets } from '../config/viewport-presets'
import { useRunStore } from '../stores/run'
import type { CaptureTask } from '../types/capture'

const store = useRunStore()
const url = ref('http://localhost:5188')
const selectedPresetIds = ref<string[]>([...defaultSelectedPresetIds])
const viewerVisible = ref(false)
const viewerTask = ref<CaptureTask | null>(null)

const resultPlatforms = computed(() =>
  viewportPresets.filter((platform) => store.tasks.some((task) => task.platformId === platform.id)),
)

async function startBatch(): Promise<void> {
  await store.startBatch(url.value.trim(), selectedPresetIds.value)
}

function viewScreenshot(task: CaptureTask): void {
  viewerTask.value = task
  viewerVisible.value = true
}
</script>

<template>
  <main class="page-shell">
    <AppHeader />
    <div class="page-content">
      <CapturePanel
        :url="url"
        :selected-preset-ids="selectedPresetIds"
        :platforms="viewportPresets"
        :running="store.isRunning"
        @update:url="url = $event"
        @update:selected-preset-ids="selectedPresetIds = $event"
        @start="startBatch"
      />
      <CaptureProgress
        :completed="store.completedCount"
        :total="store.totalCount"
        :percentage="store.progressPercentage"
        :platforms="store.platformProgress"
      />
      <ResultAccordion
        :platforms="resultPlatforms"
        :tasks="store.tasks"
        @view="viewScreenshot"
        @retry="store.retryTask"
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
