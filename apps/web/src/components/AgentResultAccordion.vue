<script setup lang="ts">
import type { AgentRun, AgentRunStatus, DeviceAgentRun } from '@viewport-lab/shared'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  run: AgentRun
  rerunListUpdatingDeviceId: string | null
}>()

defineEmits<{
  view: [device: DeviceAgentRun]
  steps: [device: DeviceAgentRun]
  toggleRerunList: [device: DeviceAgentRun, included: boolean]
}>()

const activePanels = ref<string[]>([])
const terminalStatuses = new Set<AgentRunStatus>(['completed', 'failed', 'cancelled'])

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
  return props.run.leaderDeviceId === deviceId ? 'Agent 主设备' : '复用执行'
}

function failedStepCount(device: DeviceAgentRun): number {
  return device.steps.filter((step) => step.status === 'failed').length
}

function statusLabel(status: AgentRunStatus): string {
  const labels: Partial<Record<AgentRunStatus, string>> = {
    queued: '等待',
    launching: '启动浏览器',
    running: '运行中',
    awaiting_gateway: '等待模型',
    executing: '执行中',
    capturing: '截图中',
    completed: '完成',
    failed: '失败',
    cancelled: '已取消',
  }
  return labels[status] ?? status
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
        <p>一台主设备负责 Agent 决策，其余设备同步复用工具调用</p>
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
              <span>查看大图</span>
            </button>
            <div
              v-else
              class="image-placeholder"
              :class="{ failed: device.status === 'failed' }"
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
                <span class="status-badge" :class="device.status">
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
                <div>
                  <dt>运行步骤</dt>
                  <dd>{{ device.steps.length }} 步</dd>
                </div>
                <div v-if="failedStepCount(device) > 0">
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
                <button type="button" class="steps-button" @click="$emit('steps', device)">
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

.image-button span {
  position: absolute;
  right: 10px;
  bottom: 10px;
  padding: 5px 8px;
  border-radius: 7px;
  color: #fff;
  background: rgb(22 24 35 / 72%);
  font-size: 11px;
  line-height: 1.4;
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
  justify-content: space-between;
  gap: 10px;
}

.title-row h3 {
  margin: 0;
  color: var(--color-text-strong);
  font-size: 14px;
}

.device-title {
  display: grid;
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
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--color-primary-dark);
  background: var(--color-primary-soft);
  font-size: 10px;
}

.status-badge.completed {
  color: var(--color-success);
  background: var(--color-success-soft);
}

.status-badge.failed {
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
