<script setup lang="ts">
import { ref, watch } from 'vue'

import ScreenshotGallery from './ScreenshotGallery.vue'
import type { CaptureTask, PlatformPresetGroup } from '../types/capture'

const props = defineProps<{
  platforms: PlatformPresetGroup[]
  tasks: CaptureTask[]
}>()

defineEmits<{
  view: [task: CaptureTask]
  retry: [taskId: string]
}>()

const activePanels = ref<string[]>([])

watch(
  () => props.platforms.map((platform) => platform.id).join(','),
  () => {
    activePanels.value = props.platforms.map((platform) => platform.id)
  },
  { immediate: true },
)

function tasksFor(platformId: string): CaptureTask[] {
  return props.tasks.filter((task) => task.platformId === platformId)
}
</script>

<template>
  <section class="results-section">
    <div class="results-heading">
      <div>
        <h2>截图结果</h2>
        <p>按平台查看本批次产生的真实截图</p>
      </div>
    </div>

    <div v-if="tasks.length === 0" class="empty-state surface-card">
      <span class="empty-icon" aria-hidden="true"></span>
      <strong>暂无截图结果</strong>
      <p>输入页面 URL 并选择平台后开始批量截图</p>
    </div>

    <el-collapse v-else v-model="activePanels" class="result-collapse">
      <el-collapse-item v-for="platform in platforms" :key="platform.id" :name="platform.id">
        <template #title>
          <div class="collapse-title">
            <strong>{{ platform.name }}</strong>
            <span>{{ tasksFor(platform.id).length }} 张截图</span>
          </div>
        </template>
        <ScreenshotGallery
          :tasks="tasksFor(platform.id)"
          @view="$emit('view', $event)"
          @retry="$emit('retry', $event)"
        />
      </el-collapse-item>
    </el-collapse>
  </section>
</template>

<style scoped>
.results-section {
  min-width: 0;
}

.results-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 12px;
}

.results-heading h2 {
  margin: 0;
  color: var(--color-text-strong);
  font-size: 17px;
}

.results-heading p {
  margin: 5px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.empty-state {
  display: grid;
  justify-items: center;
  padding: 52px 24px;
  color: var(--color-text-muted);
  text-align: center;
}

.empty-icon {
  position: relative;
  width: 48px;
  height: 38px;
  margin-bottom: 14px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-surface-subtle);
}

.empty-icon::after {
  position: absolute;
  right: 7px;
  bottom: 7px;
  left: 7px;
  height: 9px;
  border-radius: 3px;
  background: #e2e4ea;
  content: '';
}

.empty-state strong {
  color: var(--color-text-secondary);
  font-size: 14px;
}

.empty-state p {
  margin: 6px 0 0;
  font-size: 12px;
}

.result-collapse {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
}

.collapse-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.collapse-title strong {
  color: var(--color-text-strong);
  font-size: 14px;
}

.collapse-title span {
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--color-text-muted);
  background: var(--color-surface-subtle);
  font-size: 11px;
  font-weight: 500;
}

:deep(.el-collapse-item__header) {
  height: 52px;
  padding: 0 18px;
  border-bottom-color: var(--color-border-light);
  background: var(--color-surface);
}

:deep(.el-collapse-item__wrap) {
  border-bottom-color: var(--color-border-light);
}

:deep(.el-collapse-item__content) {
  padding: 0 18px;
}

:deep(.el-collapse-item:last-child .el-collapse-item__header),
:deep(.el-collapse-item:last-child .el-collapse-item__wrap) {
  border-bottom: 0;
}
</style>
