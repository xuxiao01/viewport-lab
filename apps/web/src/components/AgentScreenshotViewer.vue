<script setup lang="ts">
import type { AgentRun, DeviceAgentRun } from '@viewport-lab/shared'
import { computed } from 'vue'

const props = defineProps<{
  modelValue: boolean
  run: AgentRun | null
  device: DeviceAgentRun | null
}>()

defineEmits<{ 'update:modelValue': [value: boolean] }>()

const preset = computed(() =>
  props.run?.devices.find((item) => item.selectionId === props.device?.deviceId),
)
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="device ? `${device.presetName} · Agent 最终截图` : 'Agent 最终截图'"
    width="min(760px, 92vw)"
    destroy-on-close
    append-to-body
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <div v-if="device?.finalScreenshotUrl" class="viewer-content">
      <div class="viewer-meta">
        <span>
          逻辑视口 {{ preset?.viewport.width ?? '—' }} × {{ preset?.viewport.height ?? '—' }}
        </span>
        <span>DPR {{ preset?.deviceScaleFactor ?? '—' }}</span>
        <span>{{ device.steps.length }} 步</span>
      </div>
      <div class="viewer-canvas">
        <img :src="device.finalScreenshotUrl" :alt="`${device.presetName} 最终截图`" />
      </div>
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
}
</style>
