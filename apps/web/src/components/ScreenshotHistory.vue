<script setup lang="ts">
import type { BatchManifest, BatchStatus, BatchSummary } from '@viewport-lab/shared'
import { ElMessageBox } from 'element-plus'

import ResultAccordion from './ResultAccordion.vue'
import type { CaptureTask, PlatformPresetGroup } from '../types/capture'

const props = defineProps<{
  history: BatchSummary[]
  selectedBatchId: string | null
  batch: BatchManifest | null
  tasks: CaptureTask[]
  platforms: PlatformPresetGroup[]
  loading: boolean
  detailLoading: boolean
  error: string | null
  retryable: boolean
  comparisonCandidates: BatchSummary[]
  baselineBatchId: string | null
  comparisonBatchId: string | null
}>()

const emit = defineEmits<{
  select: [batchId: string]
  delete: [batchId: string]
  view: [task: CaptureTask]
  retry: [taskId: string]
  'update:baselineBatchId': [batchId: string | null]
  'update:comparisonBatchId': [batchId: string | null]
}>()

const statusLabels: Record<BatchStatus, string> = {
  queued: '等待中',
  running: '进行中',
  completed: '成功',
  partial_failed: '部分异常',
  failed: '异常',
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
}

function formatDuration(value: number | null): string {
  if (value === null) return '进行中'
  if (value < 1000) return `${value} ms`
  return `${(value / 1000).toFixed(1)} 秒`
}

function candidateLabel(batch: BatchSummary): string {
  return `${formatDate(batch.createdAt)} · ${batch.note || '无备注'}`
}

async function confirmDelete(): Promise<void> {
  if (!props.batch) return
  try {
    await ElMessageBox.confirm(
      '删除后，该批次的 manifest 和全部截图图片都将从本地磁盘永久移除。',
      '删除截图批次',
      {
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }
  emit('delete', props.batch.batchId)
}
</script>

<template>
  <section class="history-section">
    <div class="history-heading">
      <div>
        <h2>截图历史</h2>
        <p>选择历史批次查看已保存的设备截图</p>
      </div>
      <span v-if="history.length > 0">{{ history.length }} 个批次</span>
    </div>

    <div v-if="loading" class="history-loading surface-card">正在加载截图历史…</div>

    <div v-else-if="history.length === 0" class="empty-state surface-card">
      <span class="empty-icon" aria-hidden="true"></span>
      <strong>暂无截图历史</strong>
      <p>{{ error ?? '输入页面 URL、备注并选择平台后开始批量截图' }}</p>
    </div>

    <div v-else class="history-layout surface-card">
      <aside class="history-sidebar" aria-label="截图批次时间线">
        <div class="timeline-line" aria-hidden="true"></div>
        <button
          v-for="item in history"
          :key="item.batchId"
          type="button"
          class="timeline-item"
          :class="{ active: item.batchId === selectedBatchId }"
          @click="emit('select', item.batchId)"
        >
          <span class="timeline-dot" :class="item.status" aria-hidden="true"></span>
          <span class="timeline-copy">
            <strong>{{ formatDate(item.createdAt) }}</strong>
            <span class="timeline-note">{{ item.note || '未填写备注' }}</span>
            <span class="timeline-meta">
              {{ item.deviceCount }} 个设备
              <em :class="item.status">{{ statusLabels[item.status] }}</em>
            </span>
          </span>
        </button>
      </aside>

      <div class="history-detail">
        <div class="compare-toolbar">
          <div class="compare-heading">
            <strong>截图对比</strong>
            <span>已预留批次选择，像素对比功能待开放</span>
          </div>
          <div class="compare-selects">
            <el-select
              :model-value="baselineBatchId"
              clearable
              placeholder="选择基准批次"
              @update:model-value="emit('update:baselineBatchId', $event || null)"
            >
              <el-option
                v-for="item in comparisonCandidates"
                :key="item.batchId"
                :label="candidateLabel(item)"
                :value="item.batchId"
                :disabled="item.batchId === comparisonBatchId"
              />
            </el-select>
            <span class="compare-arrow" aria-hidden="true">→</span>
            <el-select
              :model-value="comparisonBatchId"
              clearable
              placeholder="选择对比批次"
              @update:model-value="emit('update:comparisonBatchId', $event || null)"
            >
              <el-option
                v-for="item in comparisonCandidates"
                :key="item.batchId"
                :label="candidateLabel(item)"
                :value="item.batchId"
                :disabled="item.batchId === baselineBatchId"
              />
            </el-select>
          </div>
        </div>

        <div v-if="detailLoading" class="detail-loading">正在加载批次详情…</div>
        <template v-else-if="batch">
          <header class="detail-header">
            <div class="detail-title">
              <div>
                <span class="status-badge" :class="batch.status">
                  {{ statusLabels[batch.status] }}
                </span>
                <strong>{{ batch.note || '未填写备注' }}</strong>
              </div>
              <button
                type="button"
                class="delete-button"
                :disabled="batch.status === 'queued' || batch.status === 'running'"
                @click="confirmDelete"
              >
                删除批次
              </button>
            </div>
            <a :href="batch.url" target="_blank" rel="noreferrer" class="target-url">
              {{ batch.url }}
            </a>
            <dl class="batch-stats">
              <div>
                <dt>创建时间</dt>
                <dd>{{ formatDate(batch.createdAt) }}</dd>
              </div>
              <div>
                <dt>耗时</dt>
                <dd>{{ formatDuration(batch.durationMs) }}</dd>
              </div>
              <div>
                <dt>模式</dt>
                <dd>{{ (batch.captureDelayMs ?? 0) === 30_000 ? '额外等待 30 秒' : '默认' }}</dd>
              </div>
              <div>
                <dt>设备</dt>
                <dd>{{ batch.deviceCount }}</dd>
              </div>
              <div>
                <dt>成功</dt>
                <dd>{{ batch.successCount }}</dd>
              </div>
              <div>
                <dt>异常</dt>
                <dd>{{ batch.failedCount }}</dd>
              </div>
            </dl>
          </header>

          <ResultAccordion
            :platforms="platforms"
            :tasks="tasks"
            :retryable="retryable"
            @view="emit('view', $event)"
            @retry="emit('retry', $event)"
          />
        </template>
        <div v-else class="detail-loading">{{ error ?? '无法加载批次详情' }}</div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.history-section {
  min-width: 0;
}

.history-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 12px;
}

.history-heading h2 {
  margin: 0;
  color: var(--color-text-strong);
  font-size: 17px;
}

.history-heading p {
  margin: 5px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.history-heading > span {
  color: var(--color-text-muted);
  font-size: 12px;
}

.history-loading,
.detail-loading {
  display: grid;
  place-items: center;
  min-height: 180px;
  color: var(--color-text-muted);
  font-size: 13px;
}

.empty-state {
  display: grid;
  justify-items: center;
  padding: 52px 24px;
  color: var(--color-text-muted);
  text-align: center;
}

.empty-icon {
  width: 48px;
  height: 38px;
  margin-bottom: 14px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: var(--color-surface-subtle);
}

.empty-state strong {
  color: var(--color-text-secondary);
  font-size: 14px;
}

.empty-state p {
  margin: 6px 0 0;
  font-size: 12px;
}

.history-layout {
  display: grid;
  grid-template-columns: 260px minmax(0, 1fr);
  min-height: 420px;
  overflow: hidden;
}

.history-sidebar {
  position: relative;
  min-width: 0;
  padding: 16px 12px;
  overflow: hidden auto;
  border-right: 1px solid var(--color-border-light);
  background: var(--color-surface-subtle);
}

.timeline-line {
  position: absolute;
  top: 26px;
  bottom: 26px;
  left: 26px;
  width: 1px;
  background: var(--color-border);
}

.timeline-item {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: 18px minmax(0, 1fr);
  gap: 8px;
  width: 100%;
  padding: 10px 9px 10px 5px;
  border: 1px solid transparent;
  border-radius: 9px;
  color: inherit;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.timeline-item:hover,
.timeline-item.active {
  border-color: var(--color-primary-border);
  background: #fff;
}

.timeline-item.active {
  box-shadow: var(--shadow-card);
}

.timeline-dot {
  width: 9px;
  height: 9px;
  margin: 5px auto 0;
  border: 2px solid var(--color-surface-subtle);
  border-radius: 50%;
  background: var(--color-text-muted);
  box-shadow: 0 0 0 1px var(--color-border);
}

.timeline-dot.completed {
  background: var(--color-success);
}

.timeline-dot.partial_failed,
.timeline-dot.failed {
  background: var(--color-danger);
}

.timeline-dot.running,
.timeline-dot.queued {
  background: var(--color-primary);
}

.timeline-copy {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.timeline-copy strong {
  color: var(--color-text-strong);
  font-size: 12px;
}

.timeline-note {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timeline-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  color: var(--color-text-muted);
  font-size: 10px;
}

.timeline-meta em {
  color: var(--color-primary-dark);
  font-style: normal;
}

.timeline-meta em.completed {
  color: var(--color-success);
}

.timeline-meta em.partial_failed,
.timeline-meta em.failed {
  color: var(--color-danger);
}

.history-detail {
  min-width: 0;
  padding: 18px;
}

.compare-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  margin-bottom: 16px;
  padding: 12px;
  border: 1px dashed var(--color-primary-border);
  border-radius: var(--radius-md);
  background: var(--color-primary-soft);
}

.compare-heading {
  display: grid;
  gap: 3px;
}

.compare-heading strong {
  color: var(--color-text-strong);
  font-size: 12px;
}

.compare-heading span {
  color: var(--color-text-muted);
  font-size: 10px;
}

.compare-selects {
  display: flex;
  align-items: center;
  gap: 7px;
}

.compare-selects :deep(.el-select) {
  width: 190px;
}

.compare-arrow {
  color: var(--color-text-muted);
}

.detail-header {
  margin-bottom: 18px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--color-border-light);
}

.detail-title,
.detail-title > div {
  display: flex;
  align-items: center;
  gap: 10px;
}

.detail-title {
  justify-content: space-between;
}

.detail-title strong {
  color: var(--color-text-strong);
  font-size: 15px;
}

.status-badge {
  padding: 4px 8px;
  border-radius: 999px;
  color: var(--color-primary-dark);
  background: var(--color-primary-soft);
  font-size: 10px;
  font-weight: 650;
}

.status-badge.completed {
  color: var(--color-success);
  background: var(--color-success-soft);
}

.status-badge.partial_failed,
.status-badge.failed {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.delete-button {
  padding: 6px 9px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  color: var(--color-danger);
  background: #fff;
  font-size: 11px;
  cursor: pointer;
}

.delete-button:disabled {
  color: var(--color-text-muted);
  cursor: not-allowed;
  opacity: 0.55;
}

.target-url {
  display: block;
  margin-top: 10px;
  overflow: hidden;
  color: var(--color-primary-dark);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.batch-stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 10px;
  margin: 14px 0 0;
}

.batch-stats div {
  display: grid;
  gap: 3px;
}

.batch-stats dt {
  color: var(--color-text-muted);
  font-size: 10px;
}

.batch-stats dd {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 650;
}

@media (max-width: 980px) {
  .history-layout {
    grid-template-columns: 1fr;
  }

  .history-sidebar {
    display: flex;
    gap: 8px;
    padding: 12px;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--color-border-light);
  }

  .timeline-line {
    display: none;
  }

  .timeline-item {
    flex: 0 0 220px;
  }
}

@media (max-width: 760px) {
  .compare-toolbar,
  .detail-title {
    align-items: stretch;
    flex-direction: column;
  }

  .compare-selects {
    display: grid;
    grid-template-columns: 1fr;
  }

  .compare-selects :deep(.el-select) {
    width: 100%;
  }

  .compare-arrow {
    display: none;
  }

  .batch-stats {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
