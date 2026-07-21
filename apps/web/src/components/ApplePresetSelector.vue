<script setup lang="ts">
import { computed } from 'vue'

import ViewportPresetCard from './ViewportPresetCard.vue'
import { getPlatformPresetIds, getPresetSelectionId } from '../config/viewport-presets'
import type { PlatformPresetGroup } from '../types/capture'

const props = defineProps<{
  platform: PlatformPresetGroup
  selectedPresetIds: string[]
  disabled: boolean
}>()

const emit = defineEmits<{
  'update:selectedPresetIds': [value: string[]]
}>()

const platformPresetIds = computed(() => getPlatformPresetIds(props.platform))
const selectedCount = computed(
  () => platformPresetIds.value.filter((id) => props.selectedPresetIds.includes(id)).length,
)

function selectAll(): void {
  const otherIds = props.selectedPresetIds.filter((id) => !platformPresetIds.value.includes(id))
  emit('update:selectedPresetIds', [...otherIds, ...platformPresetIds.value])
}

function clearAll(): void {
  emit(
    'update:selectedPresetIds',
    props.selectedPresetIds.filter((id) => !platformPresetIds.value.includes(id)),
  )
}

function togglePreset(presetId: string): void {
  const selectionId = getPresetSelectionId(props.platform.id, presetId)
  const next = props.selectedPresetIds.includes(selectionId)
    ? props.selectedPresetIds.filter((id) => id !== selectionId)
    : [...props.selectedPresetIds, selectionId]
  emit('update:selectedPresetIds', next)
}
</script>

<template>
  <section class="preset-selector">
    <div class="preset-toolbar">
      <div>
        <strong>苹果手机视口预设</strong>
        <span>已选择 {{ selectedCount }} / {{ platform.presets.length }}</span>
      </div>
      <div class="toolbar-actions">
        <button
          type="button"
          :disabled="disabled || selectedCount === platform.presets.length"
          @click="selectAll"
        >
          全选
        </button>
        <button type="button" :disabled="disabled || selectedCount === 0" @click="clearAll">
          清空
        </button>
      </div>
    </div>
    <div class="preset-grid">
      <ViewportPresetCard
        v-for="preset in platform.presets"
        :key="preset.id"
        :preset="preset"
        :selected="selectedPresetIds.includes(getPresetSelectionId(platform.id, preset.id))"
        :disabled="disabled"
        @toggle="togglePreset(preset.id)"
      />
    </div>
  </section>
</template>

<style scoped>
.preset-selector {
  margin-top: 14px;
  padding: 16px;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-md);
  background: var(--color-surface-subtle);
}

.preset-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 12px;
}

.preset-toolbar > div:first-child {
  display: flex;
  align-items: baseline;
  gap: 9px;
}

.preset-toolbar strong {
  color: var(--color-text-strong);
  font-size: 13px;
}

.preset-toolbar span {
  color: var(--color-text-muted);
  font-size: 11px;
}

.toolbar-actions {
  display: flex;
  gap: 6px;
}

.toolbar-actions button {
  padding: 5px 9px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  color: var(--color-text-secondary);
  background: #fff;
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.toolbar-actions button:hover:not(:disabled) {
  border-color: var(--color-primary-border);
  color: var(--color-primary-dark);
}

.toolbar-actions button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(235px, 1fr));
  grid-auto-rows: 1fr;
  gap: 10px;
}

@media (max-width: 560px) {
  .preset-selector {
    padding: 12px;
  }

  .preset-toolbar > div:first-child {
    display: grid;
    gap: 3px;
  }

  .preset-grid {
    grid-template-columns: 1fr;
  }
}
</style>
