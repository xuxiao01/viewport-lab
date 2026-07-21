<script setup lang="ts">
import ScreenshotCard from './ScreenshotCard.vue'
import type { CaptureTask } from '../types/capture'

defineProps<{
  tasks: CaptureTask[]
}>()

defineEmits<{
  view: [task: CaptureTask]
  retry: [taskId: string]
}>()
</script>

<template>
  <div class="screenshot-grid">
    <ScreenshotCard
      v-for="task in tasks"
      :key="task.id"
      :task="task"
      @view="$emit('view', $event)"
      @retry="$emit('retry', $event)"
    />
  </div>
</template>

<style scoped>
.screenshot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  align-items: start;
  gap: 14px;
  padding: 6px 0 18px;
}
</style>
