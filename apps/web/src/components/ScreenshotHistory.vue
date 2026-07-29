<script setup lang="ts">
import type {
  AgentRun,
  AgentRunSummary,
  BatchManifest,
  BatchStatus,
  BatchSummary,
  DeviceAgentRun,
  RerunScope,
} from '@viewport-lab/shared'
import { batchNoteMaxLength } from '@viewport-lab/shared'
import { ElMessageBox } from 'element-plus'
import { computed, nextTick, ref, watch } from 'vue'

import AgentResultAccordion from './AgentResultAccordion.vue'
import ResultAccordion from './ResultAccordion.vue'
import type { CaptureTask, PlatformPresetGroup } from '../types/capture'

const props = defineProps<{
  history: BatchSummary[]
  agentHistory: AgentRunSummary[]
  selectedBatchId: string | null
  selectedKind: 'viewport' | 'agent'
  batch: BatchManifest | null
  agentRun: AgentRun | null
  tasks: CaptureTask[]
  platforms: PlatformPresetGroup[]
  loading: boolean
  detailLoading: boolean
  error: string | null
  retryable: boolean
  running: boolean
  agentRerunning: boolean
  agentRerunListUpdatingDeviceId: string | null
  savedConfigurationSourceKeys: Set<string>
  configurationSavingSourceKey: string | null
  comparisonCandidates: BatchSummary[]
  baselineBatchId: string | null
  comparisonBatchId: string | null
}>()

const emit = defineEmits<{
  select: [batchId: string]
  selectAgent: [runId: string]
  delete: [batchId: string]
  deleteAgent: [runId: string]
  rerun: [batchId: string, scope: RerunScope]
  rerunAgent: [runId: string, scope: RerunScope]
  addConfiguration: [kind: 'viewport' | 'agent', sourceRunId: string]
  view: [task: CaptureTask]
  retry: [taskId: string]
  viewAgent: [device: DeviceAgentRun]
  viewAgentSteps: [device: DeviceAgentRun]
  toggleAgentRerunList: [device: DeviceAgentRun, included: boolean]
  updateTitle: [
    kind: 'viewport' | 'agent',
    runId: string,
    note: string,
    settled: (success: boolean) => void,
  ]
  'update:baselineBatchId': [batchId: string | null]
  'update:comparisonBatchId': [batchId: string | null]
}>()

type UnifiedHistoryItem =
  | { kind: 'viewport'; id: string; summary: BatchSummary }
  | { kind: 'agent'; id: string; summary: AgentRunSummary }

const unifiedHistory = computed<UnifiedHistoryItem[]>(() =>
  [
    ...props.history.map((summary) => ({
      kind: 'viewport' as const,
      id: summary.batchId,
      summary,
    })),
    ...props.agentHistory.map((summary) => ({
      kind: 'agent' as const,
      id: summary.runId,
      summary,
    })),
  ].sort((left, right) => right.summary.createdAt.localeCompare(left.summary.createdAt)),
)

const agentRerunDialogVisible = ref(false)
const selectedAgentRerunScope = ref<RerunScope>('all')
const agentFailedCount = computed(
  () => props.agentRun?.deviceRuns.filter((deviceRun) => deviceRun.status === 'failed').length ?? 0,
)
const agentRerunListCount = computed(() => {
  if (!props.agentRun) return 0
  const validDeviceIds = new Set(props.agentRun.deviceRuns.map((deviceRun) => deviceRun.deviceId))
  return props.agentRun.rerunDeviceIds.filter((deviceId) => validDeviceIds.has(deviceId)).length
})
const editingTitleKey = ref<string | null>(null)
const titleDraft = ref('')
const titleSaving = ref(false)

watch(
  () => `${props.selectedKind}:${props.selectedKind === 'viewport' ? props.batch?.batchId : props.agentRun?.runId}`,
  () => {
    editingTitleKey.value = null
    titleDraft.value = ''
    titleSaving.value = false
  },
)

function titleKey(kind: 'viewport' | 'agent', runId: string): string {
  return `${kind}:${runId}`
}

async function startTitleEdit(
  kind: 'viewport' | 'agent',
  runId: string,
  note: string,
): Promise<void> {
  editingTitleKey.value = titleKey(kind, runId)
  titleDraft.value = note
  await nextTick()
  document.querySelector<HTMLInputElement>('.title-editor input')?.focus()
}

function cancelTitleEdit(): void {
  if (titleSaving.value) return
  editingTitleKey.value = null
  titleDraft.value = ''
}

function saveTitle(kind: 'viewport' | 'agent', runId: string, originalNote: string): void {
  if (titleSaving.value) return
  const note = titleDraft.value.trim()
  if (note === originalNote.trim()) {
    cancelTitleEdit()
    return
  }
  titleSaving.value = true
  emit('updateTitle', kind, runId, note, (success) => {
    titleSaving.value = false
    if (success) cancelTitleEdit()
  })
}

function isSelected(item: UnifiedHistoryItem): boolean {
  if (item.kind !== props.selectedKind) return false
  return item.kind === 'viewport'
    ? item.id === props.selectedBatchId
    : item.id === props.agentRun?.runId
}

function selectItem(item: UnifiedHistoryItem): void {
  if (item.kind === 'viewport') emit('select', item.id)
  else emit('selectAgent', item.id)
}

function historyStatus(item: UnifiedHistoryItem): string {
  if (item.kind === 'viewport') return item.summary.status
  if (item.summary.status === 'queued') return 'queued'
  if (item.summary.status === 'completed') return 'completed'
  if (item.summary.status === 'failed' || item.summary.status === 'cancelled') return 'failed'
  return 'running'
}

function historyStatusLabel(item: UnifiedHistoryItem): string {
  if (item.kind === 'viewport') return statusLabels[item.summary.status]
  if (item.summary.status === 'queued') return '等待中'
  if (item.summary.status === 'completed') return '成功'
  if (item.summary.status === 'failed' || item.summary.status === 'cancelled') return '异常'
  return '进行中'
}

function historyNote(item: UnifiedHistoryItem): string {
  return item.summary.note || (item.kind === 'agent' ? item.summary.task : '未填写备注')
}

function historyDeviceCount(item: UnifiedHistoryItem): number {
  return item.summary.deviceCount
}

function configurationSourceKey(kind: 'viewport' | 'agent', sourceRunId: string): string {
  return `${kind}:${sourceRunId}`
}

function isConfigurationSaved(kind: 'viewport' | 'agent', sourceRunId: string): boolean {
  return props.savedConfigurationSourceKeys.has(configurationSourceKey(kind, sourceRunId))
}

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

async function confirmDeleteAgent(): Promise<void> {
  if (!props.agentRun) return
  try {
    await ElMessageBox.confirm(
      '删除后，该 Agent 批次的 manifest、最终截图和全部步骤记录都将从本地磁盘永久移除。',
      '删除 Agent 批次',
      {
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }
  emit('deleteAgent', props.agentRun.runId)
}

async function confirmRerun(): Promise<void> {
  if (!props.batch || !terminalBatchStatuses.has(props.batch.status) || props.running) return
  const mode = (props.batch.captureDelayMs ?? 0) === 30_000 ? '额外等待 30 秒' : '默认'
  let scope: RerunScope = 'all'
  try {
    if (props.batch.failedCount > 0) {
      await ElMessageBox.confirm(
        `原批次共 ${props.batch.deviceCount} 个设备，其中 ${props.batch.failedCount} 个失败。“重跑失败”将只更新原批次中的失败设备。`,
        '选择重跑范围',
        {
          confirmButtonText: `全部重跑（${props.batch.deviceCount}）`,
          cancelButtonText: `重跑失败（${props.batch.failedCount}）`,
          distinguishCancelAndClose: true,
          closeOnClickModal: false,
          type: 'info',
        },
      )
    } else {
      await ElMessageBox.confirm(
        `将按原参数重新执行。URL：${props.batch.url}；设备：${props.batch.deviceCount} 个；模式：${mode}。`,
        '重跑截图批次',
        {
          confirmButtonText: '确认重跑',
          cancelButtonText: '取消',
          type: 'info',
        },
      )
    }
  } catch (action) {
    if (props.batch.failedCount > 0 && action === 'cancel') scope = 'failed'
    else return
  }
  emit('rerun', props.batch.batchId, scope)
}

function confirmRerunAgent(): void {
  if (
    !props.agentRun ||
    !terminalAgentStatuses.has(props.agentRun.status) ||
    props.agentRerunning
  ) {
    return
  }
  selectedAgentRerunScope.value = 'all'
  agentRerunDialogVisible.value = true
}

function selectAgentRerunScope(scope: RerunScope): void {
  if (scope === 'failed' && agentFailedCount.value === 0) return
  if (scope === 'list' && agentRerunListCount.value === 0) return
  selectedAgentRerunScope.value = scope
}

function confirmAgentRerun(): void {
  if (!props.agentRun || props.agentRerunning) return
  const scope = selectedAgentRerunScope.value
  if (scope === 'failed' && agentFailedCount.value === 0) return
  if (scope === 'list' && agentRerunListCount.value === 0) return
  agentRerunDialogVisible.value = false
  emit('rerunAgent', props.agentRun.runId, scope)
}

const terminalBatchStatuses = new Set<BatchStatus>(['completed', 'partial_failed', 'failed'])
const terminalAgentStatuses = new Set<AgentRun['status']>(['completed', 'failed', 'cancelled'])
</script>

<template>
  <section class="history-section">
    <div class="history-heading">
      <div>
        <h2>截图历史</h2>
        <p>选择历史批次查看已保存的设备截图</p>
      </div>
      <span v-if="unifiedHistory.length > 0">{{ unifiedHistory.length }} 个批次</span>
    </div>

    <div v-if="loading" class="history-loading surface-card">正在加载截图历史…</div>

    <div v-else-if="unifiedHistory.length === 0" class="empty-state surface-card">
      <span class="empty-icon" aria-hidden="true"></span>
      <strong>暂无截图历史</strong>
      <p>{{ error ?? '输入页面 URL、备注并选择平台后开始批量截图' }}</p>
    </div>

    <div v-else class="history-layout surface-card">
      <aside class="history-sidebar" aria-label="截图批次时间线">
        <div class="timeline-line" aria-hidden="true"></div>
        <button
          v-for="item in unifiedHistory"
          :key="`${item.kind}:${item.id}`"
          type="button"
          class="timeline-item"
          :class="{ active: isSelected(item) }"
          @click="selectItem(item)"
        >
          <span class="timeline-dot" :class="historyStatus(item)" aria-hidden="true"></span>
          <span class="timeline-copy">
            <span class="timeline-topline">
              <strong>{{ formatDate(item.summary.createdAt) }}</strong>
              <em class="history-kind" :class="item.kind">
                {{ item.kind === 'agent' ? 'Agent 探索' : '视口截图' }}
              </em>
            </span>
            <span class="timeline-note">{{ historyNote(item) }}</span>
            <span class="timeline-meta">
              {{ historyDeviceCount(item) }} 个设备
              <em :class="historyStatus(item)">{{ historyStatusLabel(item) }}</em>
            </span>
          </span>
        </button>
      </aside>

      <div class="history-detail">
        <div v-if="selectedKind === 'viewport'" class="compare-toolbar">
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
        <template v-else-if="selectedKind === 'viewport' && batch">
          <header class="detail-header">
            <div class="detail-title">
              <div>
                <span class="status-badge" :class="batch.status">
                  {{ statusLabels[batch.status] }}
                </span>
                <div
                  v-if="editingTitleKey === titleKey('viewport', batch.batchId)"
                  class="title-editor"
                >
                  <el-input
                    v-model="titleDraft"
                    :maxlength="batchNoteMaxLength"
                    :disabled="titleSaving"
                    placeholder="请输入任务标题"
                    @keyup.enter.prevent="saveTitle('viewport', batch.batchId, batch.note)"
                    @keyup.esc.prevent="cancelTitleEdit"
                  />
                  <button
                    type="button"
                    class="title-confirm-button"
                    :disabled="titleSaving"
                    @click="saveTitle('viewport', batch.batchId, batch.note)"
                  >
                    {{ titleSaving ? '保存中…' : '确定' }}
                  </button>
                  <button
                    type="button"
                    class="title-cancel-button"
                    :disabled="titleSaving"
                    @click="cancelTitleEdit"
                  >
                    取消
                  </button>
                </div>
                <template v-else>
                  <strong>{{ batch.note || '未填写备注' }}</strong>
                  <button
                    type="button"
                    class="title-edit-button"
                    aria-label="修改任务标题"
                    @click="startTitleEdit('viewport', batch.batchId, batch.note)"
                  >
                    ✎ 修改
                  </button>
                </template>
              </div>
              <div class="batch-actions">
                <button
                  type="button"
                  class="configuration-button"
                  :disabled="
                    !terminalBatchStatuses.has(batch.status) ||
                    isConfigurationSaved('viewport', batch.batchId) ||
                    configurationSavingSourceKey ===
                      configurationSourceKey('viewport', batch.batchId)
                  "
                  @click="emit('addConfiguration', 'viewport', batch.batchId)"
                >
                  {{
                    isConfigurationSaved('viewport', batch.batchId)
                      ? '已加入配置清单'
                      : configurationSavingSourceKey ===
                          configurationSourceKey('viewport', batch.batchId)
                        ? '保存中…'
                        : '加入配置清单'
                  }}
                </button>
                <button
                  type="button"
                  class="rerun-button"
                  :disabled="running || !terminalBatchStatuses.has(batch.status)"
                  @click="confirmRerun"
                >
                  重跑批次
                </button>
                <button
                  type="button"
                  class="delete-button"
                  :disabled="batch.status === 'queued' || batch.status === 'running'"
                  @click="confirmDelete"
                >
                  删除批次
                </button>
              </div>
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
        <template v-else-if="selectedKind === 'agent' && agentRun">
          <header class="detail-header">
            <div class="detail-title">
              <div>
                <span class="status-badge" :class="agentRun.status">
                  {{
                    agentRun.status === 'completed'
                      ? '成功'
                      : agentRun.status === 'failed'
                        ? '异常'
                        : '运行中'
                  }}
                </span>
                <div
                  v-if="editingTitleKey === titleKey('agent', agentRun.runId)"
                  class="title-editor"
                >
                  <el-input
                    v-model="titleDraft"
                    :maxlength="batchNoteMaxLength"
                    :disabled="titleSaving"
                    placeholder="请输入任务标题"
                    @keyup.enter.prevent="saveTitle('agent', agentRun.runId, agentRun.note)"
                    @keyup.esc.prevent="cancelTitleEdit"
                  />
                  <button
                    type="button"
                    class="title-confirm-button"
                    :disabled="titleSaving"
                    @click="saveTitle('agent', agentRun.runId, agentRun.note)"
                  >
                    {{ titleSaving ? '保存中…' : '确定' }}
                  </button>
                  <button
                    type="button"
                    class="title-cancel-button"
                    :disabled="titleSaving"
                    @click="cancelTitleEdit"
                  >
                    取消
                  </button>
                </div>
                <template v-else>
                  <strong>{{ agentRun.note || 'Agent 探索' }}</strong>
                  <button
                    type="button"
                    class="title-edit-button"
                    aria-label="修改任务标题"
                    @click="startTitleEdit('agent', agentRun.runId, agentRun.note)"
                  >
                    ✎ 修改
                  </button>
                </template>
              </div>
              <div class="batch-actions">
                <button
                  type="button"
                  class="configuration-button"
                  :disabled="
                    !terminalAgentStatuses.has(agentRun.status) ||
                    isConfigurationSaved('agent', agentRun.runId) ||
                    configurationSavingSourceKey === configurationSourceKey('agent', agentRun.runId)
                  "
                  @click="emit('addConfiguration', 'agent', agentRun.runId)"
                >
                  {{
                    isConfigurationSaved('agent', agentRun.runId)
                      ? '已加入配置清单'
                      : configurationSavingSourceKey ===
                          configurationSourceKey('agent', agentRun.runId)
                        ? '保存中…'
                        : '加入配置清单'
                  }}
                </button>
                <button
                  type="button"
                  class="rerun-button"
                  :disabled="agentRerunning || !terminalAgentStatuses.has(agentRun.status)"
                  @click="confirmRerunAgent"
                >
                  {{ agentRerunning ? '重跑中…' : '重跑批次' }}
                </button>
                <button
                  type="button"
                  class="delete-button"
                  :disabled="!['completed', 'failed', 'cancelled'].includes(agentRun.status)"
                  @click="confirmDeleteAgent"
                >
                  删除批次
                </button>
              </div>
            </div>
            <a :href="agentRun.url" target="_blank" rel="noreferrer" class="target-url">
              {{ agentRun.url }}
            </a>
            <p class="agent-task">{{ agentRun.task }}</p>
            <dl class="batch-stats">
              <div>
                <dt>创建时间</dt>
                <dd>{{ formatDate(agentRun.createdAt) }}</dd>
              </div>
              <div>
                <dt>耗时</dt>
                <dd>{{ formatDuration(agentRun.durationMs) }}</dd>
              </div>
              <div>
                <dt>模式</dt>
                <dd>Agent 探索</dd>
              </div>
              <div>
                <dt>模型</dt>
                <dd>{{ agentRun.model ?? '未配置' }}</dd>
              </div>
              <div>
                <dt>设备</dt>
                <dd>{{ agentRun.deviceRuns.length }}</dd>
              </div>
              <div>
                <dt>步骤</dt>
                <dd>
                  {{ agentRun.deviceRuns.reduce((sum, device) => sum + device.steps.length, 0) }}
                </dd>
              </div>
            </dl>
          </header>
          <AgentResultAccordion
            :run="agentRun"
            :rerun-list-updating-device-id="agentRerunListUpdatingDeviceId"
            @view="emit('viewAgent', $event)"
            @steps="emit('viewAgentSteps', $event)"
            @toggle-rerun-list="
              (device, included) => emit('toggleAgentRerunList', device, included)
            "
          />
        </template>
        <div v-else class="detail-loading">{{ error ?? '无法加载批次详情' }}</div>
      </div>
    </div>

    <el-dialog
      v-model="agentRerunDialogVisible"
      title="选择 Agent 重跑范围"
      width="520px"
      :close-on-click-modal="false"
    >
      <p class="rerun-dialog-copy">
        所有操作都在当前批次内执行。未参与本次重跑的设备、图片和步骤不会改变。
      </p>
      <div v-if="agentRun" class="rerun-scope-list">
        <button
          type="button"
          class="rerun-scope-option"
          :class="{ selected: selectedAgentRerunScope === 'all' }"
          :aria-pressed="selectedAgentRerunScope === 'all'"
          :disabled="agentRerunning"
          @click="selectAgentRerunScope('all')"
        >
          <strong>全部重跑</strong>
          <span>重新执行当前批次的全部 {{ agentRun.devices.length }} 个设备</span>
        </button>
        <button
          type="button"
          class="rerun-scope-option"
          :class="{ selected: selectedAgentRerunScope === 'failed' }"
          :aria-pressed="selectedAgentRerunScope === 'failed'"
          :disabled="agentRerunning || agentFailedCount === 0"
          @click="selectAgentRerunScope('failed')"
        >
          <strong>重跑失败</strong>
          <span>只重新执行 {{ agentFailedCount }} 个最终状态为失败的设备</span>
        </button>
        <button
          type="button"
          class="rerun-scope-option rerun-list-option"
          :class="{ selected: selectedAgentRerunScope === 'list' }"
          :aria-pressed="selectedAgentRerunScope === 'list'"
          :disabled="agentRerunning || agentRerunListCount === 0"
          @click="selectAgentRerunScope('list')"
        >
          <strong>重跑重跑清单</strong>
          <span>只重新执行人工加入清单的 {{ agentRerunListCount }} 个设备</span>
        </button>
      </div>
      <template #footer>
        <div class="rerun-dialog-footer">
          <button
            type="button"
            class="dialog-cancel-button"
            @click="agentRerunDialogVisible = false"
          >
            取消
          </button>
          <button
            type="button"
            class="dialog-confirm-button"
            :disabled="agentRerunning"
            @click="confirmAgentRerun"
          >
            确定重跑
          </button>
        </div>
      </template>
    </el-dialog>
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

.timeline-topline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.history-kind {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: 999px;
  color: var(--color-text-muted);
  background: var(--color-surface-subtle);
  font-size: 9px;
  font-style: normal;
}

.history-kind.agent {
  color: var(--color-primary-dark);
  background: var(--color-primary-soft);
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

.title-editor {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  gap: 7px;
  min-width: min(460px, 52vw);
}

.title-editor :deep(.el-input) {
  min-width: 180px;
}

.title-edit-button,
.title-confirm-button,
.title-cancel-button {
  flex: 0 0 auto;
  padding: 4px 7px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text-secondary);
  background: #fff;
  font-size: 10px;
  cursor: pointer;
}

.title-edit-button {
  border-color: transparent;
  color: var(--color-primary-dark);
  background: transparent;
}

.title-confirm-button {
  color: #fff;
  border-color: var(--color-primary);
  background: var(--color-primary);
}

.title-confirm-button:disabled,
.title-cancel-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
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

.batch-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.configuration-button,
.rerun-button,
.delete-button {
  padding: 6px 9px;
  border: 1px solid var(--color-border);
  border-radius: 7px;
  background: #fff;
  font-size: 11px;
  cursor: pointer;
}

.configuration-button {
  color: var(--color-text-secondary);
}

.rerun-button {
  color: var(--color-primary-dark);
  border-color: var(--color-primary-border);
}

.delete-button {
  color: var(--color-danger);
}

.configuration-button:disabled,
.rerun-button:disabled,
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

.agent-task {
  margin: 10px 0 0;
  padding: 10px 12px;
  border-radius: 8px;
  color: var(--color-text-secondary);
  background: var(--color-surface-subtle);
  font-size: 12px;
  line-height: 1.6;
}

.batch-stats {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
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

.rerun-dialog-copy {
  margin: 0 0 14px;
  color: var(--color-text-muted);
  font-size: 13px;
  line-height: 1.6;
}

.rerun-scope-list {
  display: grid;
  gap: 10px;
}

.rerun-scope-option {
  display: grid;
  gap: 5px;
  width: 100%;
  padding: 14px 16px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  color: var(--color-text-strong);
  background: var(--color-surface);
  cursor: pointer;
  text-align: left;
}

.rerun-scope-option:hover:not(:disabled) {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
}

.rerun-scope-option.selected {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
  box-shadow: 0 0 0 1px var(--color-primary);
}

.rerun-scope-option strong {
  font-size: 14px;
}

.rerun-scope-option span {
  color: var(--color-text-muted);
  font-size: 12px;
}

.rerun-scope-option:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.rerun-dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.dialog-cancel-button,
.dialog-confirm-button {
  padding: 8px 18px;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 650;
}

.dialog-cancel-button {
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  background: var(--color-surface);
}

.dialog-confirm-button {
  border: 1px solid var(--color-primary);
  color: #fff;
  background: var(--color-primary);
}

.dialog-confirm-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
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

  .batch-actions {
    justify-content: flex-end;
  }

  .title-editor {
    min-width: 0;
    flex-wrap: wrap;
  }

  .title-editor :deep(.el-input) {
    width: 100%;
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
