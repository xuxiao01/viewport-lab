<script setup lang="ts">
import type { AgentRun, DeviceAgentRun, DeviceAgentStep } from '@viewport-lab/shared'
import { computed, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: boolean
  run: AgentRun | null
  initialDeviceId: string | null
}>()

defineEmits<{ 'update:modelValue': [value: boolean] }>()

const selectedDeviceId = ref('')
const selectedStepIndex = ref(0)

const selectedDevice = computed<DeviceAgentRun | null>(
  () => props.run?.deviceRuns.find((device) => device.deviceId === selectedDeviceId.value) ?? null,
)
const selectedStep = computed<DeviceAgentStep | null>(
  () =>
    selectedDevice.value?.steps.find((step) => step.stepIndex === selectedStepIndex.value) ?? null,
)

const visibleDevices = computed(() => {
  if (
    !props.run ||
    !['leader_resize_capture', 'leader_context_replay'].includes(props.run.executionMode)
  ) {
    return props.run?.deviceRuns ?? []
  }
  return props.run.deviceRuns.filter((device) => device.deviceId === props.run?.leaderDeviceId)
})

watch(
  () => [props.modelValue, props.initialDeviceId, props.run?.runId] as const,
  () => {
    if (!props.modelValue || !props.run) return
    const requestedDevice = visibleDevices.value.find(
      (device) => device.deviceId === props.initialDeviceId,
    )
    selectedDeviceId.value = requestedDevice?.deviceId ?? visibleDevices.value[0]?.deviceId ?? ''
    selectedStepIndex.value = selectedDevice.value?.steps[0]?.stepIndex ?? 0
  },
  { immediate: true },
)

watch(selectedDeviceId, () => {
  selectedStepIndex.value = selectedDevice.value?.steps[0]?.stepIndex ?? 0
})

const currentPosition = computed(
  () =>
    selectedDevice.value?.steps.findIndex((step) => step.stepIndex === selectedStepIndex.value) ??
    -1,
)

function move(offset: number): void {
  const steps = selectedDevice.value?.steps ?? []
  const next = steps[currentPosition.value + offset]
  if (next) selectedStepIndex.value = next.stepIndex
}

function formatDuration(value: number): string {
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} 秒`
}

function executionRole(deviceId: string): string {
  if (props.run?.executionMode === 'per_device') return '独立 Agent'
  if (props.run?.leaderDeviceId === deviceId) return 'Agent 主设备'
  if (props.run?.executionMode === 'leader_context_replay') return '独立视口重放'
  return props.run?.executionMode === 'leader_resize_capture' ? '切换视口截图' : '复用执行'
}

function waitLabel(status: 'ready' | 'timed_out'): string {
  return status === 'ready' ? '页面已就绪' : '等待超时'
}

function snapshotLabel(step: DeviceAgentStep): string {
  const meta = step.snapshotMeta
  if (!meta) return '—'
  if (!meta.changed) return `未变化，与第 ${meta.sameAsStepIndex ?? 0} 步相同`
  return `${meta.returnedChars.toLocaleString()} / ${meta.originalChars.toLocaleString()} 字符${meta.truncated ? '（已达上限）' : ''}`
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    title="Agent 每步运行"
    width="min(1180px, 94vw)"
    destroy-on-close
    append-to-body
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <div v-if="run" class="step-viewer">
      <div class="device-tabs">
        <button
          v-for="device in visibleDevices"
          :key="device.deviceId"
          type="button"
          :class="{ active: device.deviceId === selectedDeviceId }"
          @click="selectedDeviceId = device.deviceId"
        >
          <span class="device-name">{{ device.presetName }}</span>
          <span class="device-role">{{ executionRole(device.deviceId) }}</span>
          <span>{{ device.steps.length }} 步</span>
        </button>
      </div>

      <div class="step-layout">
        <aside class="step-timeline">
          <button
            v-for="step in selectedDevice?.steps ?? []"
            :key="step.stepIndex"
            type="button"
            :class="{ active: step.stepIndex === selectedStepIndex }"
            @click="selectedStepIndex = step.stepIndex"
          >
            <span class="step-index">#{{ step.stepIndex }}</span>
            <span class="step-copy">
              <strong>{{ step.command }}</strong>
              <small>{{ step.purpose || step.info?.intent || '未填写步骤说明' }}</small>
            </span>
            <em :class="step.status">{{ step.status === 'success' ? '成功' : '失败' }}</em>
          </button>
        </aside>

        <section v-if="selectedStep" class="step-detail">
          <header>
            <div>
              <span>#{{ selectedStep.stepIndex }}</span>
              <strong>{{ selectedStep.command }}</strong>
              <em :class="selectedStep.status">
                {{ selectedStep.status === 'success' ? '成功' : '失败' }}
              </em>
            </div>
            <span>{{ formatDuration(selectedStep.durationMs) }}</span>
          </header>

          <div class="step-image">
            <img
              v-if="selectedStep.screenshotUrl"
              :src="selectedStep.screenshotUrl"
              :alt="`第 ${selectedStep.stepIndex} 步截图`"
            />
            <div v-else class="image-empty">该步骤没有可用截图</div>
          </div>

          <dl class="step-meta">
            <div>
              <dt>执行目的</dt>
              <dd>{{ selectedStep.purpose || '—' }}</dd>
            </div>
            <div>
              <dt>命令参数</dt>
              <dd>{{ selectedStep.args.length ? selectedStep.args.join(' · ') : '—' }}</dd>
            </div>
            <div v-if="selectedStep.info">
              <dt>模型观察</dt>
              <dd>{{ selectedStep.info.observation || '—' }}</dd>
            </div>
            <div v-if="selectedStep.info?.issues.length">
              <dt>发现问题</dt>
              <dd>{{ selectedStep.info.issues.join('；') }}</dd>
            </div>
            <div v-if="selectedStep.output">
              <dt>工具输出</dt>
              <dd class="code-output">{{ selectedStep.output }}</dd>
            </div>
            <div v-if="selectedStep.wait">
              <dt>页面等待</dt>
              <dd>
                <span :class="['wait-state', selectedStep.wait.status]">
                  {{ waitLabel(selectedStep.wait.status) }}
                </span>
                · {{ selectedStep.wait.reason }} · {{ formatDuration(selectedStep.wait.elapsedMs) }}
              </dd>
            </div>
            <div v-if="selectedStep.page">
              <dt>页面状态</dt>
              <dd>{{ selectedStep.page.title || '无标题' }} · {{ selectedStep.page.url }}</dd>
            </div>
            <div v-if="selectedStep.snapshotMeta">
              <dt>页面快照</dt>
              <dd>{{ snapshotLabel(selectedStep) }}</dd>
            </div>
            <div v-if="selectedStep.snapshot">
              <dt>快照内容</dt>
              <dd class="code-output snapshot-output">{{ selectedStep.snapshot }}</dd>
            </div>
          </dl>

          <footer>
            <el-button :disabled="currentPosition <= 0" @click="move(-1)">上一步</el-button>
            <span>{{ currentPosition + 1 }} / {{ selectedDevice?.steps.length ?? 0 }}</span>
            <el-button
              type="primary"
              :disabled="currentPosition >= (selectedDevice?.steps.length ?? 0) - 1"
              @click="move(1)"
            >
              下一步
            </el-button>
          </footer>
        </section>
        <div v-else class="detail-empty">该设备暂无运行步骤</div>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.step-viewer {
  display: grid;
  gap: 14px;
}

.device-tabs {
  display: flex;
  gap: 8px;
  overflow-x: auto;
}

.device-tabs button {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 9px;
  color: var(--color-text-secondary);
  background: var(--color-surface);
  cursor: pointer;
  white-space: nowrap;
}

.device-tabs button.active {
  border-color: var(--color-primary);
  color: var(--color-primary-dark);
  background: var(--color-primary-soft);
}

.device-tabs span {
  color: var(--color-text-muted);
  font-size: 11px;
}

.device-tabs .device-name {
  color: inherit;
  font-size: 13px;
}

.device-tabs .device-role {
  color: var(--color-primary-dark);
  font-size: 10px;
  font-weight: 650;
}

.step-layout {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  min-height: 620px;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 12px;
}

.step-timeline {
  max-height: 72vh;
  overflow-y: auto;
  border-right: 1px solid var(--color-border);
  background: var(--color-surface-subtle);
}

.step-timeline button {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 9px;
  width: 100%;
  padding: 12px;
  border: 0;
  border-bottom: 1px solid var(--color-border-light);
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.step-timeline button.active {
  background: var(--color-primary-soft);
}

.step-index {
  color: var(--color-text-muted);
  font-size: 11px;
}

.step-copy {
  display: grid;
  gap: 3px;
  min-width: 0;
}

.step-copy strong {
  color: var(--color-text-strong);
  font-size: 12px;
}

.step-copy small {
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

em {
  color: var(--color-text-muted);
  font-size: 10px;
  font-style: normal;
}

em.success {
  color: var(--color-success);
}

em.failed {
  color: var(--color-danger);
}

.step-detail {
  display: grid;
  grid-template-rows: auto minmax(240px, 1fr) auto auto;
  gap: 12px;
  min-width: 0;
  padding: 16px;
}

.step-detail header,
.step-detail header > div,
.step-detail footer {
  display: flex;
  align-items: center;
  gap: 10px;
}

.step-detail header {
  justify-content: space-between;
}

.step-image {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  max-height: 48vh;
  overflow: auto;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: #e9ebf0;
}

.step-image img {
  display: block;
  max-width: 100%;
  height: auto;
}

.image-empty,
.detail-empty {
  display: grid;
  place-items: center;
  min-height: 240px;
  color: var(--color-text-muted);
}

.step-meta {
  display: grid;
  gap: 8px;
  margin: 0;
}

.step-meta div {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 10px;
}

.step-meta dt,
.step-meta dd {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
}

.step-meta dt {
  color: var(--color-text-muted);
}

.step-meta dd {
  color: var(--color-text-secondary);
  overflow-wrap: anywhere;
}

.code-output {
  max-height: 120px;
  padding: 8px;
  overflow: auto;
  border-radius: 7px;
  background: var(--color-surface-subtle);
  white-space: pre-wrap;
}

.snapshot-output {
  max-height: 260px;
}

.wait-state {
  font-weight: 650;
}

.wait-state.ready {
  color: var(--color-success);
}

.wait-state.timed_out {
  color: var(--color-warning, #9a6700);
}

.step-detail footer {
  justify-content: flex-end;
}

.step-detail footer span {
  color: var(--color-text-muted);
  font-size: 12px;
}

@media (max-width: 800px) {
  .step-layout {
    grid-template-columns: 1fr;
  }

  .step-timeline {
    max-height: 220px;
    border-right: 0;
    border-bottom: 1px solid var(--color-border);
  }
}
</style>
