<script setup lang="ts">
import type { AgentRunSummary, DeviceAgentRun } from '@viewport-lab/shared'
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'

import AppHeader from '../components/AppHeader.vue'
import DevicePresetPanel from '../components/DevicePresetPanel.vue'
import PlatformSelector from '../components/PlatformSelector.vue'
import {
  defaultSelectedPresetIds,
  getPlatformPresetIds,
  viewportPresets,
} from '../config/viewport-presets'
import { useAgentStore } from '../stores/agent'
import type { PlatformId } from '../types/capture'

const store = useAgentStore()
const url = ref('http://localhost:5188')
const task = ref('')
const note = ref('')
const maxTurns = ref(50)
const selectedCategories = ref<PlatformId[]>(['ios-phone'])
const activeCategory = ref<PlatformId | null>('ios-phone')
const selectedPresetIds = ref<string[]>([...defaultSelectedPresetIds])
const initializedCategories = ref<PlatformId[]>(['ios-phone'])

const effectiveSelectedPresetIds = computed(() =>
  viewportPresets.flatMap((platform) => {
    if (!selectedCategories.value.includes(platform.id)) return []
    return getPlatformPresetIds(platform).filter((id) => selectedPresetIds.value.includes(id))
  }),
)

const gatewayReady = computed(() => store.gatewayStatus?.configured ?? false)

function orderCategories(categoryIds: PlatformId[]): PlatformId[] {
  return viewportPresets
    .filter((platform) => categoryIds.includes(platform.id))
    .map((platform) => platform.id)
}

function toggleCategory(platformId: PlatformId): void {
  if (selectedCategories.value.includes(platformId)) {
    selectedCategories.value = selectedCategories.value.filter((id) => id !== platformId)
    if (activeCategory.value === platformId) {
      activeCategory.value = orderCategories(selectedCategories.value)[0] ?? null
    }
    return
  }
  if (!initializedCategories.value.includes(platformId)) {
    const platform = viewportPresets.find((item) => item.id === platformId)
    if (platform) {
      const platformPresetIds = getPlatformPresetIds(platform)
      const otherPresetIds = selectedPresetIds.value.filter((id) => !platformPresetIds.includes(id))
      selectedPresetIds.value = [...otherPresetIds, ...platformPresetIds]
    }
    initializedCategories.value = [...initializedCategories.value, platformId]
  }
  selectedCategories.value = orderCategories([...selectedCategories.value, platformId])
  activeCategory.value = platformId
}

function updateActiveCategory(platformId: PlatformId): void {
  if (selectedCategories.value.includes(platformId)) activeCategory.value = platformId
}

async function startAgentRun(): Promise<void> {
  if (!task.value.trim()) {
    ElMessage.warning('请输入 Agent 任务描述')
    return
  }
  await store.createRun({
    url: url.value.trim(),
    task: task.value.trim(),
    note: note.value.trim(),
    selectedPresetIds: effectiveSelectedPresetIds.value,
    maxTurns: maxTurns.value,
  })
  if (store.error) ElMessage.error(store.error)
}

async function deleteRun(runId: string): Promise<void> {
  try {
    await store.deleteRun(runId)
    ElMessage.success('Agent 运行已删除')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除 Agent 运行失败')
  }
}

function formatSummary(summary: AgentRunSummary): string {
  const devices = `${summary.completedDeviceCount}/${summary.deviceCount} 设备`
  const steps = `${summary.stepCount} 步`
  const duration = summary.durationMs ? ` · ${Math.round(summary.durationMs / 1000)}s` : ''
  return `${devices} · ${steps}${duration}`
}

const screenshotMode = ref<'compact' | 'full'>('compact')

function lastScreenshot(dr: DeviceAgentRun): string | null {
  for (const step of [...dr.steps].reverse()) {
    if (step.screenshotUrl) return step.screenshotUrl
  }
  return null
}

onMounted(() => {
  void store.loadGatewayStatus()
  void store.loadHistory()
})
</script>

<template>
  <main class="page-shell">
    <AppHeader />
    <div class="page-content">
      <section class="surface-card panel">
        <h2>Agent 探索任务</h2>
        <p v-if="gatewayReady" class="gateway-ok">
          网关已连接 · 模型 {{ store.gatewayStatus?.model }}
        </p>
        <p v-else class="gateway-warn">
          网关未配置{{ store.gatewayStatus?.reason ? ` · ${store.gatewayStatus.reason}` : '' }}
        </p>
        <div class="form-row">
          <label>目标 URL</label>
          <el-input v-model="url" placeholder="https://example.com" />
        </div>
        <div class="form-row">
          <label>任务描述</label>
          <el-input
            v-model="task"
            type="textarea"
            :rows="3"
            placeholder="例如：打开首页，点击第一个商品，截图后返回"
          />
        </div>
        <div class="form-row">
          <label>备注</label>
          <el-input v-model="note" placeholder="可选备注" maxlength="200" />
        </div>
        <div class="form-row">
          <label>最大轮数</label>
          <el-input-number v-model="maxTurns" :min="1" :max="100" />
        </div>
        <div class="form-row">
          <label>设备视口</label>
          <PlatformSelector
            :platforms="viewportPresets"
            :selected-categories="selectedCategories"
            :selected-preset-ids="selectedPresetIds"
            :disabled="store.creating || store.isRunning"
            @toggle-category="toggleCategory"
          />
          <DevicePresetPanel
            :platforms="viewportPresets"
            :selected-categories="selectedCategories"
            :active-category="activeCategory"
            :selected-preset-ids="selectedPresetIds"
            :disabled="store.creating || store.isRunning"
            @update:active-category="updateActiveCategory"
            @update:selected-preset-ids="selectedPresetIds = $event"
          />
        </div>
        <div class="form-actions">
          <el-button type="primary" :loading="store.creating" @click="startAgentRun">
            启动 Agent 运行
          </el-button>
        </div>
      </section>

      <section v-if="store.currentRun" class="surface-card panel">
        <div class="run-header-row">
          <h2>当前运行</h2>
          <el-button
            size="small"
            @click="screenshotMode = screenshotMode === 'compact' ? 'full' : 'compact'"
          >
            {{ screenshotMode === 'compact' ? '展开全部截图' : '收起截图' }}
          </el-button>
        </div>
        <div class="run-meta">
          <span>状态: {{ store.currentRun.status }}</span>
          <span
            >设备进度: {{ store.completedDeviceCount }} /
            {{ store.currentRun.deviceRuns.length }}</span
          >
          <span
            >步骤总数:
            {{ store.currentRun.deviceRuns.reduce((s, dr) => s + dr.steps.length, 0) }}</span
          >
        </div>
        <div v-if="store.currentRun.error" class="run-error">{{ store.currentRun.error }}</div>
        <div class="device-grid">
          <div v-for="dr in store.deviceRuns" :key="dr.deviceId" class="device-card">
            <div class="device-header">
              <span class="device-name">{{ dr.presetName }}</span>
              <span :class="['device-status', dr.status]">{{ dr.status }}</span>
              <span class="device-cli">{{ dr.cliDeviceName }}</span>
            </div>
            <div v-if="dr.error" class="device-error">{{ dr.error }}</div>

            <div
              v-if="screenshotMode === 'compact' && lastScreenshot(dr)"
              class="device-screenshot"
            >
              <span class="device-screenshot-label">最新截图</span>
              <img
                :src="lastScreenshot(dr) ?? undefined"
                :alt="`${dr.presetName} 最新截图`"
                loading="lazy"
              />
            </div>

            <div :class="['device-steps', { expanded: screenshotMode === 'full' }]">
              <div v-for="step in dr.steps" :key="step.stepIndex" class="device-step">
                <div class="step-main">
                  <span class="step-index">#{{ step.stepIndex }}</span>
                  <span class="step-cmd">{{ step.command }}</span>
                  <span :class="['step-status', step.status]">{{ step.status }}</span>
                  <span v-if="step.info" class="step-intent">{{ step.info.intent }}</span>
                  <a
                    v-if="step.screenshotUrl && screenshotMode === 'compact'"
                    :href="step.screenshotUrl"
                    target="_blank"
                    class="step-shot-link"
                    >截图</a
                  >
                </div>
                <a
                  v-if="screenshotMode === 'full' && step.screenshotUrl"
                  :href="step.screenshotUrl"
                  target="_blank"
                  class="step-shot"
                  :aria-label="`${dr.presetName} 第 ${step.stepIndex} 步截图`"
                >
                  <img
                    :src="step.screenshotUrl"
                    :alt="`${dr.presetName} #${step.stepIndex}`"
                    loading="lazy"
                  />
                </a>
                <div v-else-if="screenshotMode === 'full'" class="step-shot-placeholder">
                  该步骤暂无截图
                </div>
              </div>
              <div v-if="dr.steps.length === 0" class="empty-state">暂无步骤</div>
            </div>
            <div v-if="dr.testScriptUrl" class="device-spec">
              <a :href="dr.testScriptUrl" target="_blank">spec.ts</a>
            </div>
            <div v-if="dr.summary" class="device-summary">
              <span class="summary-confidence">{{ dr.summary.confidence }}</span>
              <span class="summary-text">{{ dr.summary.observation }}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="surface-card panel">
        <h2>运行历史</h2>
        <div v-if="store.historyLoading" class="empty-state">加载中…</div>
        <div v-else-if="store.runHistory.length === 0" class="empty-state">暂无 Agent 运行记录</div>
        <ul v-else class="history-list">
          <li
            v-for="run in store.runHistory"
            :key="run.runId"
            :class="['history-item', { selected: store.selectedRunId === run.runId }]"
          >
            <button class="history-button" @click="store.selectRun(run.runId)">
              <span class="history-status" :data-status="run.status">{{ run.status }}</span>
              <span class="history-url">{{ run.url }}</span>
              <span class="history-task">{{ run.task }}</span>
              <span class="history-meta">{{ formatSummary(run) }}</span>
            </button>
            <el-button size="small" type="danger" text @click="deleteRun(run.runId)">
              删除
            </el-button>
          </li>
        </ul>
      </section>
    </div>
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

.panel {
  padding: 20px 22px;
}

.panel h2 {
  margin: 0 0 14px;
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text-strong);
}

.run-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.run-header-row h2 {
  margin: 0;
}

.gateway-ok {
  margin: 0 0 14px;
  color: var(--color-success);
  font-size: 13px;
}

.gateway-warn {
  margin: 0 0 14px;
  color: var(--color-text-muted);
  font-size: 13px;
}

.form-row {
  display: grid;
  gap: 6px;
  margin-bottom: 14px;
}

.form-row label {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}

.run-meta {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--color-text-secondary);
  margin-bottom: 12px;
}

.run-error {
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--color-danger-soft);
  color: var(--color-danger);
  font-size: 13px;
  margin-bottom: 12px;
}

.device-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.device-card {
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  display: grid;
  gap: 8px;
}

.device-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}

.device-name {
  font-weight: 700;
  color: var(--color-text-strong);
}

.device-status {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--color-surface-subtle);
}

.device-status.completed {
  color: var(--color-success);
}

.device-status.failed {
  color: var(--color-danger);
}

.device-cli {
  font-size: 11px;
  color: var(--color-text-muted);
  font-family: monospace;
}

.device-error {
  font-size: 12px;
  color: var(--color-danger);
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--color-danger-soft);
}

.device-screenshot {
  display: grid;
  gap: 6px;
}

.device-screenshot-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
}

.device-screenshot img {
  width: 100%;
  max-width: 280px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  display: block;
}

.device-steps {
  display: grid;
  gap: 4px;
}

.device-steps.expanded {
  max-height: 560px;
  overflow-y: auto;
  padding-right: 4px;
  gap: 10px;
}

.device-step {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
}

.device-steps.expanded .device-step {
  display: grid;
  align-items: stretch;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--color-border-light);
  border-radius: 8px;
  background: var(--color-surface);
}

.step-main {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.step-index {
  font-weight: 700;
  color: var(--color-text-muted);
}

.step-cmd {
  font-family: monospace;
  background: var(--color-primary-soft);
  color: var(--color-primary-dark);
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 11px;
}

.step-status.success {
  color: var(--color-success);
}

.step-status.failed {
  color: var(--color-danger);
}

.step-intent {
  color: var(--color-text-secondary);
  font-size: 11px;
}

.step-shot-link {
  color: var(--color-primary);
  font-size: 11px;
}

.step-shot {
  display: block;
}

.step-shot img {
  width: 100%;
  max-width: 280px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  display: block;
}

.step-shot-placeholder {
  color: var(--color-text-muted);
  font-size: 11px;
  padding: 10px 12px;
  border: 1px dashed var(--color-border);
  border-radius: 6px;
  background: var(--color-surface-subtle);
}

.device-spec a {
  font-size: 12px;
  font-family: monospace;
  color: var(--color-primary);
}

.device-summary {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  border-top: 1px solid var(--color-border-light);
  padding-top: 6px;
}

.summary-confidence {
  font-weight: 600;
  text-transform: uppercase;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--color-surface-subtle);
}

.summary-text {
  color: var(--color-text-secondary);
}

.empty-state {
  color: var(--color-text-muted);
  font-size: 14px;
  padding: 16px 0;
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 8px;
}

.history-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-md);
  padding: 4px 8px;
}

.history-item.selected {
  border-color: var(--color-primary-border);
  background: var(--color-primary-soft);
}

.history-button {
  flex: 1;
  display: grid;
  grid-template-columns: auto 1fr 1fr auto;
  gap: 12px;
  align-items: center;
  background: none;
  border: none;
  padding: 8px 4px;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
}

.history-status {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--color-surface-subtle);
}

.history-status[data-status='completed'] {
  color: var(--color-success);
}

.history-status[data-status='failed'] {
  color: var(--color-danger);
}

.history-url {
  font-size: 13px;
  color: var(--color-text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-task {
  font-size: 12px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-meta {
  font-size: 11px;
  color: var(--color-text-muted);
}

@media (max-width: 720px) {
  .page-shell {
    width: min(100% - 24px, 640px);
    padding-bottom: 36px;
  }

  .history-button {
    grid-template-columns: 1fr;
    gap: 4px;
  }

  .device-grid {
    grid-template-columns: 1fr;
  }
}
</style>
