<script setup lang="ts">
import { agentModelNames, agentTurnLimits, batchNoteMaxLength } from '@viewport-lab/shared'
import type { AgentGatewayStatus, AgentModelName, CaptureDelayMs } from '@viewport-lab/shared'
import { computed } from 'vue'

import DevicePresetPanel from './DevicePresetPanel.vue'
import PlatformSelector from './PlatformSelector.vue'
import { getPlatformPresetIds } from '../config/viewport-presets'
import type { PlatformId, PlatformPresetGroup } from '../types/capture'

const props = defineProps<{
  url: string
  note: string
  aiTaskDescription: string
  maxTurns: number
  model: AgentModelName
  captureDelayMs: CaptureDelayMs
  gatewayStatus: AgentGatewayStatus | null
  selectedCategories: PlatformId[]
  activeCategory: PlatformId | null
  selectedPresetIds: string[]
  platforms: PlatformPresetGroup[]
  running: boolean
  optimizing: boolean
}>()

const emit = defineEmits<{
  'update:url': [value: string]
  'update:note': [value: string]
  'update:aiTaskDescription': [value: string]
  'update:maxTurns': [value: number]
  'update:model': [value: AgentModelName]
  'update:captureDelayMs': [value: CaptureDelayMs]
  'update:activeCategory': [value: PlatformId]
  'update:selectedPresetIds': [value: string[]]
  toggleCategory: [platformId: PlatformId]
  optimizeTask: []
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

const isAgentMode = computed(() => props.aiTaskDescription.trim().length > 0)

const isValidUrl = computed(() => {
  try {
    const url = new URL(props.url)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
})

const gatewayReady = computed(() => props.gatewayStatus?.configured ?? false)
const modelOptions = agentModelNames.map((value) => ({ value, label: value }))
const canOptimize = computed(
  () =>
    isValidUrl.value &&
    props.aiTaskDescription.trim().length > 0 &&
    gatewayReady.value &&
    !props.running &&
    !props.optimizing,
)
const canStart = computed(
  () =>
    isValidUrl.value &&
    selectedPresetCount.value > 0 &&
    !props.running &&
    (!isAgentMode.value || gatewayReady.value),
)

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

function updateModel(value: string): void {
  if (agentModelNames.includes(value as AgentModelName)) {
    emit('update:model', value as AgentModelName)
  }
}
</script>

<template>
  <section class="capture-panel surface-card">
    <div class="section-heading">
      <div>
        <h2>创建检测任务</h2>
        <p>填写 AI 任务描述即可探索页面，留空则直接批量截图</p>
      </div>
    </div>

    <label class="field-label" for="target-url">目标页面 URL</label>
    <el-input
      id="target-url"
      :model-value="url"
      size="large"
      placeholder="请输入需要检测的完整页面地址，例如 http://localhost:5188"
      clearable
      :disabled="running"
      @update:model-value="emit('update:url', $event)"
      @keyup.enter="canStart && emit('start')"
    />
    <p v-if="url && !isValidUrl" class="field-error">请输入有效的 HTTP 或 HTTPS URL</p>

    <label class="field-label spaced-label" for="batch-note">任务标题 / 备注（可选）</label>
    <el-input
      id="batch-note"
      :model-value="note"
      placeholder="例如：首页移动端适配检查"
      clearable
      show-word-limit
      :maxlength="batchNoteMaxLength"
      :disabled="running"
      @update:model-value="emit('update:note', $event)"
    />

    <div class="ai-task-label-row spaced-label">
      <label class="field-label" for="ai-task-description">AI 任务描述（可选）</label>
      <el-button
        size="small"
        plain
        type="primary"
        :loading="optimizing"
        :disabled="!canOptimize"
        @click="emit('optimizeTask')"
      >
        {{ optimizing ? '优化中…' : 'AI 优化任务' }}
      </el-button>
    </div>
    <el-input
      id="ai-task-description"
      :model-value="aiTaskDescription"
      type="textarea"
      :rows="4"
      placeholder="例如：依次检查首页、课程详情页和支付页，重点关注按钮遮挡、文字溢出和横向滚动，并在关键步骤截图。"
      :disabled="running"
      @update:model-value="emit('update:aiTaskDescription', $event)"
    />
    <p class="ai-helper">
      留空时，将直接按下方选定的设备视口进行页面截图；填写后，Agent
      将根据任务描述操作和探索页面，并在关键步骤截图。
    </p>
    <p
      v-if="isAgentMode"
      class="gateway-status"
      :class="{ ready: gatewayReady, unavailable: gatewayStatus && !gatewayReady }"
    >
      <template v-if="!gatewayStatus">正在检查 AI 网关配置…</template>
      <template v-else-if="gatewayReady">AI 网关已连接</template>
      <template v-else>
        AI 网关不可用{{ gatewayStatus.reason ? ` · ${gatewayStatus.reason}` : '' }}
      </template>
    </p>

    <template v-if="isAgentMode">
      <div class="mode-heading">
        <strong>Agent 设置</strong>
        <span>设置每台设备的最大操作轮数和本次运行模型</span>
      </div>
      <div class="agent-settings">
        <div class="agent-setting-item">
          <label for="agent-max-turns">最大轮数</label>
          <el-input-number
            id="agent-max-turns"
            :model-value="maxTurns"
            :min="agentTurnLimits.min"
            :max="agentTurnLimits.max"
            :disabled="running"
            @update:model-value="typeof $event === 'number' && emit('update:maxTurns', $event)"
          />
          <span>范围 100–200，默认 150</span>
        </div>
        <div class="agent-setting-item model-setting">
          <label for="agent-model">选择模型</label>
          <el-select
            id="agent-model"
            :model-value="model"
            :disabled="running"
            aria-label="选择 Agent 模型"
            @update:model-value="updateModel"
          >
            <el-option
              v-for="option in modelOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
          <span>默认 deepseek-v4-flash-0731</span>
        </div>
      </div>
    </template>
    <template v-else>
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
    </template>

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

    <div class="form-actions">
      <span>{{ selectedPresetCount }} 个{{ isAgentMode ? '设备任务' : '截图任务' }}</span>
      <el-button
        class="capture-button"
        type="primary"
        size="large"
        :disabled="!canStart"
        :loading="running"
        @click="emit('start')"
      >
        {{
          running
            ? isAgentMode
              ? 'AI 探索中'
              : '批量截图中'
            : isAgentMode
              ? '开始 AI 探索'
              : '开始批量截图'
        }}
      </el-button>
    </div>
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

.agent-settings {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 18px;
  min-height: 54px;
  padding: 10px 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-surface-subtle);
}

.agent-setting-item {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.agent-setting-item label {
  flex: 0 0 auto;
  color: var(--color-text-strong);
  font-size: 13px;
  font-weight: 650;
}

.agent-setting-item span {
  color: var(--color-text-muted);
  font-size: 12px;
}

.model-setting :deep(.el-select) {
  width: 220px;
  max-width: 100%;
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

.field-label {
  display: block;
  margin-bottom: 8px;
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 650;
}

.spaced-label {
  margin-top: 15px;
}

.ai-task-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.ai-task-label-row .field-label {
  margin: 0;
}

.ai-helper {
  margin: 8px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.gateway-status {
  margin: 8px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.gateway-status.ready {
  color: var(--color-success);
}

.gateway-status.unavailable {
  color: var(--color-danger);
}

.capture-button {
  min-width: 148px;
}

.form-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  margin-top: 22px;
  padding-top: 16px;
  border-top: 1px solid var(--color-border-light);
}

.form-actions > span {
  color: var(--color-text-muted);
  font-size: 12px;
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

  .agent-settings {
    grid-template-columns: 1fr;
  }

  .agent-setting-item {
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .agent-setting-item span {
    flex-basis: 100%;
  }

  .form-actions {
    align-items: stretch;
    flex-direction: column;
  }

  .form-actions > span {
    text-align: right;
  }
}
</style>
