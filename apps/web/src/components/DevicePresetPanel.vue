<script setup lang="ts">
import { computed } from 'vue'

import ViewportPresetCard from './ViewportPresetCard.vue'
import { getPlatformPresetIds, getPresetSelectionId } from '../config/viewport-presets'
import type { PlatformId, PlatformPresetGroup } from '../types/capture'

const props = defineProps<{
  platforms: PlatformPresetGroup[]
  selectedCategories: PlatformId[]
  activeCategory: PlatformId | null
  selectedPresetIds: string[]
  disabled: boolean
}>()

const emit = defineEmits<{
  'update:activeCategory': [value: PlatformId]
  'update:selectedPresetIds': [value: string[]]
}>()

const selectedPlatforms = computed(() =>
  props.platforms.filter((platform) => props.selectedCategories.includes(platform.id)),
)

const activePlatform = computed(() =>
  selectedPlatforms.value.find((platform) => platform.id === props.activeCategory),
)

const activePresetIds = computed(() =>
  activePlatform.value ? getPlatformPresetIds(activePlatform.value) : [],
)

const activeSelectedCount = computed(
  () => activePresetIds.value.filter((id) => props.selectedPresetIds.includes(id)).length,
)

function getSelectedCount(platform: PlatformPresetGroup): number {
  return getPlatformPresetIds(platform).filter((id) => props.selectedPresetIds.includes(id)).length
}

function selectAll(): void {
  if (!activePlatform.value) return
  const otherIds = props.selectedPresetIds.filter((id) => !activePresetIds.value.includes(id))
  emit('update:selectedPresetIds', [...otherIds, ...activePresetIds.value])
}

function clearAll(): void {
  emit(
    'update:selectedPresetIds',
    props.selectedPresetIds.filter((id) => !activePresetIds.value.includes(id)),
  )
}

function togglePreset(presetId: string): void {
  if (!activePlatform.value) return
  const selectionId = getPresetSelectionId(activePlatform.value.id, presetId)
  const next = props.selectedPresetIds.includes(selectionId)
    ? props.selectedPresetIds.filter((id) => id !== selectionId)
    : [...props.selectedPresetIds, selectionId]
  emit('update:selectedPresetIds', next)
}
</script>

<template>
  <section class="preset-panel">
    <div class="panel-toolbar">
      <div>
        <strong>设备视口预设</strong>
        <span v-if="activePlatform">
          已选择 {{ activeSelectedCount }} / {{ activePlatform.presets.length }}
        </span>
      </div>
      <div v-if="activePlatform" class="toolbar-actions">
        <button
          type="button"
          :disabled="disabled || activeSelectedCount === activePlatform.presets.length"
          @click="selectAll"
        >
          全选
        </button>
        <button type="button" :disabled="disabled || activeSelectedCount === 0" @click="clearAll">
          清空
        </button>
      </div>
    </div>

    <div v-if="selectedPlatforms.length > 0" class="category-tabs" role="tablist">
      <button
        v-for="platform in selectedPlatforms"
        :key="platform.id"
        type="button"
        role="tab"
        :aria-selected="platform.id === activeCategory"
        :class="{ active: platform.id === activeCategory }"
        @click="emit('update:activeCategory', platform.id)"
      >
        {{ platform.name }} {{ getSelectedCount(platform) }}/{{ platform.presets.length }}
      </button>
    </div>

    <p v-if="activePlatform?.notice" class="platform-notice">
      {{ activePlatform.notice }}
    </p>

    <div v-if="activePlatform" class="preset-grid" role="tabpanel">
      <ViewportPresetCard
        v-for="preset in activePlatform.presets"
        :key="preset.id"
        :preset="preset"
        :selected="selectedPresetIds.includes(getPresetSelectionId(activePlatform.id, preset.id))"
        :disabled="disabled"
        @toggle="togglePreset(preset.id)"
      />
    </div>

    <div v-else class="preset-empty">
      <strong>尚未选择平台</strong>
      <span>从上方选择至少一个平台后，在这里配置设备视口预设</span>
    </div>
  </section>
</template>

<style scoped>
.preset-panel {
  margin-top: 14px;
  padding: 16px;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-md);
  background: var(--color-surface-subtle);
}

.panel-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.panel-toolbar > div:first-child {
  display: flex;
  align-items: baseline;
  gap: 9px;
}

.panel-toolbar strong {
  color: var(--color-text-strong);
  font-size: 13px;
}

.panel-toolbar span {
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

.category-tabs {
  display: flex;
  gap: 4px;
  margin: 14px 0 12px;
  overflow-x: auto;
  border-bottom: 1px solid var(--color-border);
}

.category-tabs button {
  position: relative;
  flex: 0 0 auto;
  padding: 8px 11px 10px;
  border: 0;
  color: var(--color-text-muted);
  background: transparent;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}

.category-tabs button::after {
  position: absolute;
  right: 8px;
  bottom: -1px;
  left: 8px;
  height: 2px;
  border-radius: 2px 2px 0 0;
  background: transparent;
  content: '';
}

.category-tabs button.active {
  color: var(--color-primary-dark);
}

.category-tabs button.active::after {
  background: var(--color-primary);
}

.platform-notice {
  margin: 0 0 12px;
  padding: 9px 11px;
  border: 1px solid var(--color-primary-border);
  border-radius: 8px;
  color: var(--color-text-secondary);
  background: var(--color-primary-soft);
  font-size: 11px;
  line-height: 1.55;
}

.preset-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(235px, 1fr));
  grid-auto-rows: 1fr;
  gap: 10px;
}

.preset-empty {
  display: grid;
  justify-items: center;
  gap: 5px;
  min-height: 132px;
  padding: 34px 18px;
  color: var(--color-text-muted);
  text-align: center;
}

.preset-empty strong {
  color: var(--color-text-secondary);
  font-size: 13px;
}

.preset-empty span {
  font-size: 11px;
}

@media (max-width: 560px) {
  .preset-panel {
    padding: 12px;
  }

  .panel-toolbar > div:first-child {
    display: grid;
    gap: 3px;
  }

  .preset-grid {
    grid-template-columns: 1fr;
  }
}
</style>
