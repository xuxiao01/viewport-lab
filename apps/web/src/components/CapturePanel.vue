<script setup lang="ts">
import { batchNoteMaxLength } from '@viewport-lab/shared'
import type { CaptureDelayMs } from '@viewport-lab/shared'
import { computed } from 'vue'

import DevicePresetPanel from './DevicePresetPanel.vue'
import PlatformSelector from './PlatformSelector.vue'
import { getPlatformPresetIds } from '../config/viewport-presets'
import type { PlatformId, PlatformPresetGroup } from '../types/capture'

const props = defineProps<{
  url: string
  note: string
  captureDelayMs: CaptureDelayMs
  selectedCategories: PlatformId[]
  activeCategory: PlatformId | null
  selectedPresetIds: string[]
  platforms: PlatformPresetGroup[]
  running: boolean
}>()

const emit = defineEmits<{
  'update:url': [value: string]
  'update:note': [value: string]
  'update:captureDelayMs': [value: CaptureDelayMs]
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

const captureModes: Array<{
  value: CaptureDelayMs
  title: string
  description: string
}> = [
  {
    value: 0,
    title: '默认模式',
    description: '页面达到就绪条件后立即截图',
  },
  {
    value: 30_000,
    title: '额外等待 30 秒',
    description: '首次就绪后等待 30 秒，再次检查稳定性',
  },
]
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

    <label class="note-label" for="batch-note">本次备注（可选）</label>
    <el-input
      id="batch-note"
      :model-value="note"
      placeholder="例如：调整头部高度、修复 360px 横向溢出"
      clearable
      show-word-limit
      :maxlength="batchNoteMaxLength"
      :disabled="running"
      @update:model-value="emit('update:note', $event)"
    />

    <div class="mode-heading">
      <strong>截图模式</strong>
      <span>30 秒模式适合需要等待异步数据或动画稳定的页面</span>
    </div>
    <div class="capture-modes">
      <button
        v-for="mode in captureModes"
        :key="mode.value"
        type="button"
        class="capture-mode"
        :class="{ active: captureDelayMs === mode.value }"
        :disabled="running"
        @click="emit('update:captureDelayMs', mode.value)"
      >
        <span class="mode-indicator" aria-hidden="true"></span>
        <span class="mode-copy">
          <strong>{{ mode.title }}</strong>
          <small>{{ mode.description }}</small>
        </span>
      </button>
    </div>

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

.mode-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin: 18px 0 9px;
}

.mode-heading strong {
  color: var(--color-text-secondary);
  font-size: 13px;
}

.mode-heading span {
  color: var(--color-text-muted);
  font-size: 12px;
}

.capture-modes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.capture-mode {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  color: inherit;
  background: var(--color-surface-subtle);
  text-align: left;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease;
}

.capture-mode:hover:not(:disabled) {
  border-color: var(--color-primary-border);
}

.capture-mode.active {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
}

.capture-mode:disabled {
  cursor: not-allowed;
  opacity: 0.65;
}

.mode-indicator {
  flex: 0 0 auto;
  width: 13px;
  height: 13px;
  margin-top: 2px;
  border: 1px solid var(--color-border);
  border-radius: 50%;
  background: #fff;
}

.capture-mode.active .mode-indicator {
  border: 4px solid var(--color-primary);
}

.mode-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.mode-copy strong {
  color: var(--color-text-strong);
  font-size: 13px;
}

.mode-copy small {
  color: var(--color-text-muted);
  font-size: 11px;
  line-height: 1.5;
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

.url-label,
.note-label {
  display: block;
  margin-bottom: 8px;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 650;
}

.note-label {
  margin-top: 15px;
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

  .capture-modes {
    grid-template-columns: 1fr;
  }

  .mode-heading span {
    display: none;
  }

  .platform-heading span {
    display: none;
  }
}
</style>
