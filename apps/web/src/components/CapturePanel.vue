<script setup lang="ts">
import { computed } from 'vue'

import DevicePresetPanel from './DevicePresetPanel.vue'
import PlatformSelector from './PlatformSelector.vue'
import { getPlatformPresetIds } from '../config/viewport-presets'
import type { PlatformId, PlatformPresetGroup } from '../types/capture'

const props = defineProps<{
  url: string
  selectedCategories: PlatformId[]
  activeCategory: PlatformId | null
  selectedPresetIds: string[]
  platforms: PlatformPresetGroup[]
  running: boolean
}>()

const emit = defineEmits<{
  'update:url': [value: string]
  'update:activeCategory': [value: PlatformId]
  'update:selectedPresetIds': [value: string[]]
  toggleCategory: [platformId: PlatformId]
  start: []
}>()

const selectedPresetCount = computed(() =>
  props.platforms.reduce((count, platform) => {
    if (!props.selectedCategories.includes(platform.id)) return count
    return (
      count +
      getPlatformPresetIds(platform).filter((id) => props.selectedPresetIds.includes(id)).length
    )
  }, 0),
)

const isValidUrl = computed(() => {
  try {
    const url = new URL(props.url)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
})

const canStart = computed(() => isValidUrl.value && selectedPresetCount.value > 0 && !props.running)
</script>

<template>
  <section class="capture-panel surface-card">
    <div class="section-heading">
      <div>
        <h2>创建截图任务</h2>
        <p>输入目标页面并选择需要检查的平台</p>
      </div>
      <span>{{ selectedPresetCount }} 个截图任务</span>
    </div>

    <label class="url-label" for="target-url">目标页面完整 URL</label>
    <div class="url-row">
      <el-input
        id="target-url"
        :model-value="url"
        size="large"
        placeholder="https://example.com/page"
        clearable
        :disabled="running"
        @update:model-value="emit('update:url', $event)"
        @keyup.enter="canStart && emit('start')"
      />
      <el-button
        class="capture-button"
        type="primary"
        size="large"
        :disabled="!canStart"
        :loading="running"
        @click="emit('start')"
      >
        {{ running ? '批量截图中' : '开始批量截图' }}
      </el-button>
    </div>
    <p v-if="url && !isValidUrl" class="field-error">请输入有效的 HTTP 或 HTTPS URL</p>

    <div class="platform-heading">
      <strong>选择平台</strong>
      <span>支持多选，执行所选平台下已勾选的预设</span>
    </div>
    <PlatformSelector
      :platforms="platforms"
      :selected-categories="selectedCategories"
      :selected-preset-ids="selectedPresetIds"
      :disabled="running"
      @toggle-category="emit('toggleCategory', $event)"
    />
    <DevicePresetPanel
      :platforms="platforms"
      :selected-categories="selectedCategories"
      :active-category="activeCategory"
      :selected-preset-ids="selectedPresetIds"
      :disabled="running"
      @update:active-category="emit('update:activeCategory', $event)"
      @update:selected-preset-ids="emit('update:selectedPresetIds', $event)"
    />
  </section>
</template>

<style scoped>
.capture-panel {
  padding: 22px;
}

.section-heading,
.platform-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
}

.section-heading {
  margin-bottom: 20px;
}

.section-heading h2 {
  margin: 0;
  color: var(--color-text-strong);
  font-size: 17px;
}

.section-heading p,
.platform-heading span {
  margin: 5px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.section-heading > span {
  flex: 0 0 auto;
  padding: 5px 9px;
  border-radius: 999px;
  color: var(--color-primary-dark);
  background: var(--color-primary-soft);
  font-size: 12px;
  font-weight: 650;
}

.url-label {
  display: block;
  margin-bottom: 8px;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 650;
}

.url-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
}

.capture-button {
  min-width: 148px;
}

.field-error {
  margin: 7px 0 0;
  color: var(--color-danger);
  font-size: 12px;
}

.platform-heading {
  align-items: baseline;
  margin: 22px 0 11px;
}

.platform-heading strong {
  color: var(--color-text-secondary);
  font-size: 13px;
}

.platform-heading span {
  margin: 0;
}

:deep(.el-input__wrapper) {
  border-radius: 10px;
  box-shadow: 0 0 0 1px var(--color-border) inset;
}

:deep(.el-input__wrapper.is-focus) {
  box-shadow: 0 0 0 1px var(--color-primary) inset;
}

@media (max-width: 680px) {
  .capture-panel {
    padding: 18px;
  }

  .url-row {
    grid-template-columns: 1fr;
  }

  .capture-button {
    width: 100%;
  }

  .platform-heading span {
    display: none;
  }
}
</style>
