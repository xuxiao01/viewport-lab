<script setup lang="ts">
import type {
  AgentRunSummary,
  DeviceAgentRun,
  DeviceAgentStep,
  RetryRun,
  RetryRunSummary,
} from '@viewport-lab/shared'
import { ElButton, ElMessage, ElTag } from 'element-plus'
import { computed, onMounted, ref } from 'vue'

import AppHeader from '../components/AppHeader.vue'
import { useBatchStore } from '../stores/batch'

const store = useBatchStore()
const screenshotMode = ref<'compact' | 'full'>('compact')
const loadingRetries = ref(false)

const completedBatches = computed(() => store.batches.filter((b) => b.status === 'completed'))

const selectedRetries = computed<RetryRunSummary[]>(() =>
  store.selectedRunId ? (store.retrySummaries.get(store.selectedRunId) ?? []) : [],
)

const selectedRetry = computed<RetryRun | null>(() =>
  store.selectedRetryId ? (store.retryDetails.get(store.selectedRetryId) ?? null) : null,
)

function sanitizeId(id: string): string {
  return id.replace(/:/g, '-')
}

function findDeviceRun(deviceId: string): DeviceAgentRun | null {
  if (!store.currentAgentRun) return null
  return store.currentAgentRun.deviceRuns.find((dr) => sanitizeId(dr.deviceId) === deviceId) ?? null
}

function lastScreenshot(deviceId: string): string | null {
  const retry = selectedRetry.value
  if (!retry) return null
  const dr = retry.deviceResults.find((d) => d.deviceId === deviceId)
  if (!dr || dr.screenshots.length === 0) return null
  return [...dr.screenshots].sort((a, b) => a.stepIndex - b.stepIndex).at(-1)?.url ?? null
}

function screenshotForStep(deviceId: string, stepIndex: number): string | null {
  const retry = selectedRetry.value
  if (!retry) return null
  const dr = retry.deviceResults.find((d) => d.deviceId === deviceId)
  return dr?.screenshots.find((shot) => shot.stepIndex === stepIndex)?.url ?? null
}

function getSteps(deviceId: string): DeviceAgentStep[] {
  const dr = findDeviceRun(deviceId)
  return dr?.steps ?? []
}

function deviceTitle(deviceId: string): string {
  const retry = selectedRetry.value
  if (!retry) return deviceId
  const dr = retry.deviceResults.find((d) => d.deviceId === deviceId)
  if (dr) return `${dr.platformName} ${dr.presetName}`
  return deviceId
}

function formatBatchMeta(batch: AgentRunSummary): string {
  const devices = `${batch.completedDeviceCount}/${batch.deviceCount} 设备`
  const steps = `${batch.stepCount} 步`
  const duration = batch.durationMs ? ` · ${Math.round(batch.durationMs / 1000)}s` : ''
  return `${devices} · ${steps}${duration}`
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN')
}

function statusTag(status: string): 'success' | 'danger' | 'info' | 'warning' {
  switch (status) {
    case 'completed':
    case 'passed':
      return 'success'
    case 'failed':
      return 'danger'
    case 'running':
      return 'warning'
    default:
      return 'info'
  }
}

function retryCount(runId: string): number {
  return store.retrySummaries.get(runId)?.length ?? 0
}

async function handleSelectBatch(runId: string): Promise<void> {
  loadingRetries.value = true
  try {
    await store.selectBatch(runId)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '加载重试记录失败')
  } finally {
    loadingRetries.value = false
  }
}

async function handleSelectRetry(runId: string, retryId: string): Promise<void> {
  await store.selectRetry(runId, retryId)
}

async function retry(batch: AgentRunSummary): Promise<void> {
  await store.retryBatch(batch.runId)
}

onMounted(() => {
  void store.loadBatches()
})
</script>

<template>
  <main class="page-shell">
    <AppHeader />
    <div class="page-content">
      <section class="surface-card panel">
        <div class="panel-header">
          <h2>批次重放</h2>
          <el-button size="small" :loading="store.loading" @click="store.loadBatches()">
            刷新
          </el-button>
        </div>
        <p v-if="completedBatches.length === 0 && !store.loading" class="empty-state">
          暂无已完成的 Agent 运行批次
        </p>
        <div v-if="store.loading" class="empty-state">加载中…</div>
        <div v-else class="batch-list">
          <div
            v-for="batch in completedBatches"
            :key="batch.runId"
            :class="['batch-item', { selected: store.selectedRunId === batch.runId }]"
          >
            <div class="batch-info">
              <el-tag :type="statusTag(batch.status)" size="small">{{ batch.status }}</el-tag>
              <span class="batch-url">{{ batch.url }}</span>
              <span class="batch-task">{{ batch.task }}</span>
              <span class="batch-meta">{{ formatBatchMeta(batch) }}</span>
              <span class="batch-time">{{ formatTime(batch.createdAt) }}</span>
            </div>
            <div class="batch-actions">
              <el-button
                size="small"
                :type="store.selectedRunId === batch.runId ? 'primary' : 'default'"
                @click="handleSelectBatch(batch.runId)"
              >
                查看重试 ({{ retryCount(batch.runId) }})
              </el-button>
              <el-button
                size="small"
                type="success"
                :loading="store.retrying && store.selectedRunId === batch.runId"
                @click="retry(batch)"
              >
                重跑
              </el-button>
            </div>
          </div>
        </div>
      </section>

      <section v-if="store.selectedRunId && selectedRetries.length > 0" class="surface-card panel">
        <h2>重试历史</h2>
        <div class="retry-list">
          <div
            v-for="r in selectedRetries"
            :key="r.retryId"
            :class="['retry-item', { selected: store.selectedRetryId === r.retryId }]"
          >
            <div class="retry-info">
              <el-tag :type="statusTag(r.status)" size="small">{{ r.status }}</el-tag>
              <span class="retry-time">{{ formatTime(r.startedAt) }}</span>
              <span class="retry-meta">
                {{ r.passedCount }}/{{ r.deviceCount }} 通过
                <template v-if="r.failedCount > 0"> · {{ r.failedCount }} 失败</template>
                <template v-if="r.skippedCount > 0"> · {{ r.skippedCount }} 跳过</template>
              </span>
            </div>
            <el-button
              size="small"
              :type="store.selectedRetryId === r.retryId ? 'primary' : 'default'"
              @click="handleSelectRetry(r.runId, r.retryId)"
            >
              查看详情
            </el-button>
          </div>
        </div>
      </section>

      <section
        v-if="
          store.selectedRunId && selectedRetries.length === 0 && !loadingRetries && !store.retrying
        "
        class="surface-card panel"
      >
        <h2>重试历史</h2>
        <p class="empty-state">暂无重试记录 · 点击上方"重跑"按钮执行首次重试</p>
      </section>

      <section v-if="loadingRetries" class="surface-card panel">
        <h2>重试历史</h2>
        <p class="empty-state">加载中…</p>
      </section>

      <section v-if="selectedRetry" class="surface-card panel">
        <div class="panel-header">
          <h2>重试结果</h2>
          <el-button
            size="small"
            @click="screenshotMode = screenshotMode === 'compact' ? 'full' : 'compact'"
          >
            {{ screenshotMode === 'compact' ? '展开全部截图' : '收起截图' }}
          </el-button>
        </div>
        <div v-if="selectedRetry.error" class="retry-error">{{ selectedRetry.error }}</div>
        <div class="device-grid">
          <div v-for="dr in selectedRetry.deviceResults" :key="dr.deviceId" class="device-card">
            <div class="device-header">
              <span class="device-name">{{ deviceTitle(dr.deviceId) }}</span>
              <el-tag :type="statusTag(dr.status)" size="small">
                {{ dr.status }}
              </el-tag>
              <span v-if="dr.durationMs" class="device-duration">
                {{ Math.round(dr.durationMs / 1000) }}s
              </span>
            </div>

            <div v-if="dr.error" class="device-error">{{ dr.error }}</div>

            <div
              v-if="screenshotMode === 'compact' && lastScreenshot(dr.deviceId)"
              class="device-screenshot"
            >
              <span class="device-screenshot-label">最新截图</span>
              <img
                :src="lastScreenshot(dr.deviceId) ?? undefined"
                :alt="`${dr.presetName} 最新截图`"
                loading="lazy"
              />
            </div>

            <div v-if="dr.output" class="device-output">
              <pre>{{ dr.output }}</pre>
            </div>

            <div
              v-if="getSteps(dr.deviceId).length > 0"
              :class="['device-steps', { expanded: screenshotMode === 'full' }]"
            >
              <div class="steps-label">原始 Agent 步骤：</div>
              <div v-for="step in getSteps(dr.deviceId)" :key="step.stepIndex" class="device-step">
                <div class="step-main">
                  <span class="step-index">#{{ step.stepIndex }}</span>
                  <span class="step-cmd">{{ step.command }}</span>
                  <span :class="['step-status', step.status]">{{ step.status }}</span>
                  <span v-if="step.info" class="step-intent">{{ step.info.intent }}</span>
                  <span v-if="step.locator" class="step-locator">定位: {{ step.locator }}</span>
                </div>
                <a
                  v-if="screenshotMode === 'full' && screenshotForStep(dr.deviceId, step.stepIndex)"
                  :href="screenshotForStep(dr.deviceId, step.stepIndex) ?? undefined"
                  target="_blank"
                  class="step-shot"
                  :aria-label="`${dr.presetName} 第 ${step.stepIndex} 步截图`"
                >
                  <img
                    :src="screenshotForStep(dr.deviceId, step.stepIndex) ?? undefined"
                    :alt="`${dr.presetName} #${step.stepIndex}`"
                    loading="lazy"
                  />
                </a>
                <div v-else-if="screenshotMode === 'full'" class="step-shot-placeholder">
                  该步骤暂无截图
                </div>
              </div>
            </div>
          </div>
        </div>
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

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}

.panel-header h2 {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text-strong);
}

.panel h2 {
  margin: 0 0 14px;
  font-size: 18px;
  font-weight: 700;
  color: var(--color-text-strong);
}

.empty-state {
  color: var(--color-text-muted);
  font-size: 14px;
  padding: 16px 0;
}

.batch-list {
  display: grid;
  gap: 10px;
}

.batch-item {
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-md);
  padding: 12px 14px;
  display: grid;
  gap: 8px;
}

.batch-item.selected {
  border-color: var(--color-primary-border);
  background: var(--color-primary-soft);
}

.batch-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.batch-url {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 280px;
}

.batch-task {
  font-size: 12px;
  color: var(--color-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

.batch-meta {
  font-size: 11px;
  color: var(--color-text-muted);
}

.batch-time {
  font-size: 11px;
  color: var(--color-text-muted);
  margin-left: auto;
}

.batch-actions {
  display: flex;
  gap: 8px;
}

.retry-list {
  display: grid;
  gap: 8px;
}

.retry-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-md);
  padding: 8px 14px;
}

.retry-item.selected {
  border-color: var(--color-primary-border);
  background: var(--color-primary-soft);
}

.retry-info {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  color: var(--color-text-secondary);
}

.retry-time {
  font-size: 12px;
  color: var(--color-text-muted);
}

.retry-meta {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.retry-error {
  color: var(--color-danger);
  font-size: 13px;
  padding: 8px 12px;
  background: var(--color-danger-soft);
  border-radius: var(--radius-md);
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

.device-duration {
  font-size: 11px;
  color: var(--color-text-muted);
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

.device-output {
  max-height: 120px;
  overflow-y: auto;
}

.device-output pre {
  margin: 0;
  padding: 6px 8px;
  background: var(--color-surface);
  border-radius: 4px;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--color-text-secondary);
}

.device-steps {
  display: grid;
  gap: 4px;
  border-top: 1px solid var(--color-border-light);
  padding-top: 6px;
}

.device-steps.expanded {
  max-height: 560px;
  overflow-y: auto;
  padding-right: 4px;
  gap: 10px;
}

.steps-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  margin-bottom: 2px;
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

.step-locator {
  font-size: 10px;
  font-family: monospace;
  color: var(--color-text-muted);
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

@media (max-width: 720px) {
  .page-shell {
    width: min(100% - 24px, 640px);
    padding-bottom: 36px;
  }

  .device-grid {
    grid-template-columns: 1fr;
  }

  .batch-info {
    grid-template-columns: 1fr;
  }
}
</style>
