<script setup lang="ts">
import type { RunStatus } from '@viewport-lab/shared'
import { computed } from 'vue'

import type { CaptureTask } from '../types/capture'

const props = defineProps<{
  task: CaptureTask
  retryable?: boolean
}>()

defineEmits<{
  view: [task: CaptureTask]
  retry: [taskId: string]
}>()

const statusLabel: Record<RunStatus, string> = {
  queued: '等待',
  launching: '启动浏览器',
  navigating: '打开页面',
  waiting: '等待页面',
  capturing: '截图中',
  completed: '完成',
  failed: '失败',
}

const isActive = computed(() => !['completed', 'failed'].includes(props.task.status))

const placeholderStyle = computed(() => ({
  aspectRatio: `${props.task.preset.viewport.width} / ${props.task.preset.viewport.height}`,
}))

const imagePixelSize = computed(() => ({
  width: Math.round(props.task.preset.viewport.width * props.task.preset.deviceScaleFactor),
  height: Math.round(props.task.preset.viewport.height * props.task.preset.deviceScaleFactor),
}))

function formatTime(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '—'
}
</script>

<template>
  <article class="screenshot-card">
    <button
      v-if="task.status === 'completed' && task.run?.screenshotUrl"
      type="button"
      class="image-button"
      aria-label="查看截图大图"
      @click="$emit('view', task)"
    >
      <img :src="task.run.screenshotUrl" :alt="`${task.preset.name} 截图`" loading="lazy" />
      <span>查看大图</span>
    </button>
    <div
      v-else
      class="image-placeholder"
      :class="{ failed: task.status === 'failed' }"
      :style="placeholderStyle"
    >
      <span v-if="isActive" class="loading-ring" aria-hidden="true"></span>
      <span v-else class="failure-mark" aria-hidden="true">!</span>
      <strong>{{ statusLabel[task.status] }}</strong>
      <small v-if="task.status === 'failed'">{{ task.error ?? '截图任务失败' }}</small>
    </div>

    <div class="card-body">
      <div class="title-row">
        <h3>{{ task.preset.name }}</h3>
        <span class="status-badge" :class="task.status">{{ statusLabel[task.status] }}</span>
      </div>
      <dl>
        <div>
          <dt>逻辑视口</dt>
          <dd>{{ task.preset.viewport.width }} × {{ task.preset.viewport.height }}</dd>
        </div>
        <div>
          <dt>PNG 像素</dt>
          <dd>{{ imagePixelSize.width }} × {{ imagePixelSize.height }}</dd>
        </div>
        <div>
          <dt>DPR</dt>
          <dd>{{ task.preset.deviceScaleFactor }}</dd>
        </div>
        <div>
          <dt>截图时间</dt>
          <dd>{{ formatTime(task.run?.completedAt) }}</dd>
        </div>
      </dl>
      <button
        v-if="task.status === 'failed' && retryable"
        type="button"
        class="retry-button"
        @click="$emit('retry', task.id)"
      >
        重新截图
      </button>
    </div>
  </article>
</template>

<style scoped>
.screenshot-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--color-border-light);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  transition:
    transform 160ms ease,
    box-shadow 160ms ease;
}

.screenshot-card:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-card-hover);
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
  opacity: 0;
  transition: opacity 160ms ease;
}

.image-button:hover span {
  opacity: 1;
}

.image-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  gap: 9px;
  color: var(--color-text-muted);
  background: linear-gradient(145deg, #f4f5f8, #e9ebf1);
}

.image-placeholder.failed {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.image-placeholder strong {
  font-size: 13px;
}

.image-placeholder small {
  max-width: 85%;
  overflow: hidden;
  color: var(--color-text-muted);
  font-size: 11px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.loading-ring {
  width: 24px;
  height: 24px;
  border: 2px solid #d8d9e4;
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 800ms linear infinite;
}

.failure-mark {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border: 1px solid currentcolor;
  border-radius: 50%;
  font-weight: 750;
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

h3 {
  margin: 0;
  overflow: hidden;
  color: var(--color-text-strong);
  font-size: 14px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-badge {
  flex: 0 0 auto;
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--color-text-muted);
  background: var(--color-surface-subtle);
  font-size: 10px;
  font-weight: 650;
}

.status-badge.launching,
.status-badge.navigating,
.status-badge.waiting,
.status-badge.capturing {
  color: var(--color-primary-dark);
  background: var(--color-primary-soft);
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
  margin: 13px 0 0;
}

dl div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 11px;
}

dt {
  color: var(--color-text-muted);
}

dd {
  margin: 0;
  color: var(--color-text-secondary);
  font-weight: 550;
  text-align: right;
}

.retry-button {
  width: 100%;
  margin-top: 12px;
  padding: 7px 10px;
  border: 1px solid var(--color-primary-border);
  border-radius: 8px;
  color: var(--color-primary-dark);
  background: #fff;
  font-size: 12px;
  font-weight: 650;
  cursor: pointer;
}

.retry-button:hover {
  background: var(--color-primary-soft);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
