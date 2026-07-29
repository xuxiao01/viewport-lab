<script setup lang="ts">
import type { AgentRun, AgentRunStatus, DeviceAgentRun } from '@viewport-lab/shared'
import { ElMessage } from 'element-plus'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  run: AgentRun
  rerunListUpdatingDeviceId: string | null
}>()

const emit = defineEmits<{
  view: [device: DeviceAgentRun]
  steps: [device: DeviceAgentRun]
  toggleRerunList: [device: DeviceAgentRun, included: boolean]
}>()

const activePanels = ref<string[]>([])
const terminalStatuses = new Set<AgentRunStatus>(['completed', 'failed', 'cancelled'])
type AgentDisplayStatus = 'waiting' | 'in-progress' | 'success' | 'failure'

const displayStatusByRunStatus: Record<AgentRunStatus, AgentDisplayStatus> = {
  queued: 'waiting',
  launching: 'in-progress',
  running: 'in-progress',
  awaiting_gateway: 'in-progress',
  executing: 'in-progress',
  capturing: 'in-progress',
  completed: 'success',
  failed: 'failure',
  cancelled: 'failure',
}

const displayStatusLabels: Record<AgentDisplayStatus, string> = {
  waiting: '等待',
  'in-progress': '进行中',
  success: '成功',
  failure: '失败',
}

const platforms = computed(() => {
  const seen = new Set<string>()
  return props.run.devices.flatMap((device) => {
    if (seen.has(device.platformId)) return []
    seen.add(device.platformId)
    return [{ id: device.platformId, name: device.platformName }]
  })
})

watch(
  platforms,
  (items) => {
    activePanels.value = items.map((item) => item.id)
  },
  { immediate: true },
)

function devicesFor(platformId: string): DeviceAgentRun[] {
  return props.run.deviceRuns.filter((device) => device.platformId === platformId)
}

function preset(device: DeviceAgentRun) {
  return props.run.devices.find((item) => item.selectionId === device.deviceId)
}

function isInRerunList(deviceId: string): boolean {
  return props.run.rerunDeviceIds.includes(deviceId)
}

function executionRole(deviceId: string): string {
  if (props.run.executionMode === 'per_device') return '独立 Agent'
  if (props.run.leaderDeviceId === deviceId) return 'Agent 主设备'
  return props.run.executionMode === 'leader_resize_capture' ? '切换视口截图' : '复用执行'
}

function hasStepHistory(device: DeviceAgentRun): boolean {
  return props.run.leaderDeviceId === device.deviceId || device.steps.length > 0
}

function canViewSteps(device: DeviceAgentRun): boolean {
  return (
    props.run.executionMode !== 'leader_resize_capture' ||
    props.run.leaderDeviceId === device.deviceId
  )
}

function handleViewSteps(device: DeviceAgentRun): void {
  if (!canViewSteps(device)) {
    ElMessage.info('暂时不支持查看非主设备每一步截图')
    return
  }
  emit('steps', device)
}

function failedStepCount(device: DeviceAgentRun): number {
  return device.steps.filter((step) => step.status === 'failed').length
}

function displayStatus(status: AgentRunStatus): AgentDisplayStatus {
  return displayStatusByRunStatus[status]
}

function statusLabel(status: AgentRunStatus): string {
  return displayStatusLabels[displayStatus(status)]
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}
</script>

<template>
  <section class="results-section">
    <div class="results-heading">
      <div>
        <h2>设备截图</h2>
        <p>主设备完成 Agent 操作后，系统切换各逻辑视口保存最终截图</p>
      </div>
    </div>

    <el-collapse v-model="activePanels" class="result-collapse">
      <el-collapse-item v-for="platform in platforms" :key="platform.id" :name="platform.id">
        <template #title>
          <div class="collapse-title">
            <strong>{{ platform.name }}</strong>
            <span>{{ devicesFor(platform.id).length }} 张截图</span>
          </div>
        </template>
        <div class="screenshot-grid">
          <article
            v-for="device in devicesFor(platform.id)"
            :key="device.deviceId"
            class="screenshot-card"
          >
            <button
              v-if="device.finalScreenshotUrl"
              type="button"
              class="image-button"
              aria-label="查看 Agent 最终截图"
              @click="$emit('view', device)"
            >
              <img
                :src="device.finalScreenshotUrl"
                :alt="`${device.presetName} Agent 最终截图`"
                loading="lazy"
              />
            </button>
            <div
              v-else
              class="image-placeholder"
              :class="{ failed: displayStatus(device.status) === 'failure' }"
              :style="{
                aspectRatio: `${preset(device)?.viewport.width ?? 390} / ${preset(device)?.viewport.height ?? 844}`,
              }"
            >
              <strong>{{ statusLabel(device.status) }}</strong>
              <small>{{ device.error ?? '暂无最终截图' }}</small>
            </div>

            <div class="card-body">
              <div class="title-row">
                <div class="device-title">
                  <h3>{{ device.presetName }}</h3>
                  <span
                    class="role-label"
                    :class="{ leader: run.leaderDeviceId === device.deviceId }"
                  >
                    {{ executionRole(device.deviceId) }}
                  </span>
                </div>
                <span class="status-badge" :class="displayStatus(device.status)">
                  {{ statusLabel(device.status) }}
                </span>
              </div>
              <dl>
                <div>
                  <dt>逻辑视口</dt>
                  <dd>
                    {{ preset(device)?.viewport.width ?? '—' }} ×
                    {{ preset(device)?.viewport.height ?? '—' }}
                  </dd>
                </div>
                <div v-if="hasStepHistory(device)">
                  <dt>运行步骤</dt>
                  <dd>{{ device.steps.length }} 步</dd>
                </div>
                <div v-if="hasStepHistory(device) && failedStepCount(device) > 0">
                  <dt>失败调用</dt>
                  <dd class="failed-count">{{ failedStepCount(device) }} 次</dd>
                </div>
                <div>
                  <dt>DPR</dt>
                  <dd>{{ preset(device)?.deviceScaleFactor ?? '—' }}</dd>
                </div>
                <div>
                  <dt>完成时间</dt>
                  <dd>{{ formatTime(props.run.completedAt) }}</dd>
                </div>
              </dl>
              <p v-if="device.error" class="device-error">{{ device.error }}</p>
              <div class="card-actions">
                <button
                  type="button"
                  class="rerun-list-button"
                  :class="{ selected: isInRerunList(device.deviceId) }"
                  :disabled="
                    !terminalStatuses.has(run.status) || rerunListUpdatingDeviceId !== null
                  "
                  @click="$emit('toggleRerunList', device, !isInRerunList(device.deviceId))"
                >
                  {{
                    rerunListUpdatingDeviceId === device.deviceId
                      ? '保存中…'
                      : isInRerunList(device.deviceId)
                        ? '移出重跑清单'
                        : '加入重跑清单'
                  }}
                </button>
                <button
                  type="button"
                  class="steps-button"
                  :title="
                    canViewSteps(device)
                      ? '查看 Agent 每步运行'
                      : '暂时不支持查看非主设备每一步截图'
                  "
                  @click="handleViewSteps(device)"
                >
                  查看每步运行
                </button>
              </div>
            </div>
          </article>
        </div>
      </el-collapse-item>
    </el-collapse>
  </section>
</template>

<style scoped>
.results-heading {
  margin-bottom: 12px;
}

.results-heading h2 {
  margin: 0;
  color: var(--color-text-strong);
  font-size: 17px;
}

.results-heading p {
  margin: 5px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.result-collapse {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}

.collapse-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.collapse-title span {
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--color-text-muted);
  background: var(--color-surface-subtle);
  font-size: 11px;
}

:deep(.el-collapse-item__header) {
  height: 52px;
  padding: 0 18px;
}

:deep(.el-collapse-item__content) {
  padding: 0 18px;
}

.screenshot-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  align-items: start;
  gap: 14px;
  padding: 6px 0 18px;
}

.screenshot-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-md);
  background: var(--color-surface);
}

.image-button,
.image-placeholder {
  position: relative;
  width: 100%;
  border: 0;
}

.image-button {
  display: block;
  padding: 0;
  overflow: hidden;
  background: #fff;
  cursor: zoom-in;
  line-height: 0;
}

.image-button img {
  display: block;
  width: 100%;
  height: auto;
}

.image-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 8px;
  color: var(--color-text-muted);
  background: var(--color-surface-subtle);
}

.image-placeholder.failed {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.image-placeholder small {
  max-width: 85%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-body {
  padding: 14px;
}

.title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.title-row h3 {
  margin: 0;
  overflow: hidden;
  color: var(--color-text-strong);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.device-title {
  display: grid;
  flex: 1 1 auto;
  gap: 5px;
  min-width: 0;
}

.role-label {
  color: var(--color-text-muted);
  font-size: 10px;
  font-weight: 650;
}

.role-label.leader {
  color: var(--color-primary-dark);
}

.status-badge {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 48px;
  height: 24px;
  padding: 0 8px;
  border-radius: 999px;
  color: var(--color-text-muted);
  background: var(--color-surface-subtle);
  font-size: 10px;
  font-weight: 650;
  line-height: 1;
  white-space: nowrap;
}

.status-badge.in-progress {
  color: var(--color-primary-dark);
  background: var(--color-primary-soft);
}

.status-badge.success {
  color: var(--color-success);
  background: var(--color-success-soft);
}

.status-badge.failure {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

dl {
  display: grid;
  gap: 6px;
  margin: 13px 0;
}

dl div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}

dt,
dd {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 11px;
}

dd {
  color: var(--color-text-secondary);
  text-align: right;
}

.failed-count {
  color: var(--color-danger);
  font-weight: 650;
}

.device-error {
  margin: 0 0 10px;
  color: var(--color-danger);
  font-size: 11px;
  line-height: 1.5;
}

.card-actions {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
}

.rerun-list-button,
.steps-button {
  padding: 8px 6px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 650;
  white-space: nowrap;
}

.rerun-list-button {
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  background: var(--color-surface);
}

.rerun-list-button.selected {
  border-color: #d9a400;
  color: #9a6700;
  background: #fff8db;
}

.rerun-list-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.steps-button {
  border: 1px solid var(--color-primary);
  color: var(--color-primary-dark);
  background: var(--color-primary-soft);
}
</style>
