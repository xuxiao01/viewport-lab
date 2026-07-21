<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { CaptureTask } from '../types/capture'

const props = defineProps<{
  modelValue: boolean
  task: CaptureTask | null
}>()

defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const imageNaturalSize = ref<{ width: number; height: number } | null>(null)

const dialogWidth = computed(() => {
  const viewportWidth = props.task?.preset.viewport.width ?? 390
  return `min(${viewportWidth + 56}px, 92vw)`
})

const imageStyle = computed(() => ({
  width: `${props.task?.preset.viewport.width ?? 390}px`,
}))

watch(
  () => props.task?.run?.screenshotUrl,
  () => {
    imageNaturalSize.value = null
  },
)

function handleImageLoad(event: Event): void {
  const image = event.currentTarget
  if (!(image instanceof HTMLImageElement)) return
  imageNaturalSize.value = { width: image.naturalWidth, height: image.naturalHeight }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="task?.preset.name ?? '截图预览'"
    :width="dialogWidth"
    destroy-on-close
    append-to-body
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <div v-if="task?.run?.screenshotUrl" class="viewer-content">
      <div class="viewer-meta">
        <span>逻辑视口 {{ task.preset.viewport.width }} × {{ task.preset.viewport.height }}</span>
        <span>DPR {{ task.preset.deviceScaleFactor }}</span>
        <span v-if="imageNaturalSize">
          PNG {{ imageNaturalSize.width }} × {{ imageNaturalSize.height }}
        </span>
      </div>
      <div class="viewer-canvas">
        <img
          :src="task.run.screenshotUrl"
          :alt="`${task.preset.name} 大图`"
          :style="imageStyle"
          @load="handleImageLoad"
        />
      </div>
      <p class="viewer-hint">
        截图按逻辑 CSS 像素 1:1 展示，高 DPR 原图会缩放到对应的逻辑视口宽度。
      </p>
    </div>
  </el-dialog>
</template>

<style scoped>
.viewer-content {
  display: grid;
  gap: 10px;
}

.viewer-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.viewer-meta span {
  padding: 4px 8px;
  border-radius: 7px;
  color: var(--color-text-secondary);
  background: var(--color-surface-subtle);
  font-size: 12px;
}

.viewer-canvas {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  max-height: 74vh;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: #e9ebf0;
}

.viewer-canvas img {
  display: block;
  max-width: 100%;
  height: auto;
  background: #fff;
}

.viewer-hint {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.5;
}
</style>
