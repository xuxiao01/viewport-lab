<script setup lang="ts">
import type { PlatformCaptureStatus, PlatformProgressItem } from '../types/capture'

defineProps<{
  completed: number
  total: number
  percentage: number
  platforms: PlatformProgressItem[]
}>()

const statusLabel: Record<PlatformCaptureStatus, string> = {
  waiting: '等待',
  capturing: '截图中',
  completed: '完成',
  failed: '失败',
}
</script>

<template>
  <section v-if="total > 0" class="progress-panel surface-card">
    <div class="progress-header">
      <div>
        <h2>批量截图进度</h2>
        <p>{{ completed }} / {{ total }} 个任务已结束</p>
      </div>
      <strong>{{ percentage }}%</strong>
    </div>
    <el-progress :percentage="percentage" :show-text="false" :stroke-width="8" color="#6558e8" />
    <div class="platform-statuses">
      <div v-for="platform in platforms" :key="platform.platformId" class="status-item">
        <span class="status-dot" :class="platform.status"></span>
        <span>{{ platform.name }}</span>
        <small>{{ platform.completed }}/{{ platform.total }}</small>
        <em :class="platform.status">{{ statusLabel[platform.status] }}</em>
      </div>
    </div>
  </section>
</template>

<style scoped>
.progress-panel {
  padding: 20px 22px;
}

.progress-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

h2 {
  margin: 0;
  color: var(--color-text-strong);
  font-size: 15px;
}

p {
  margin: 4px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.progress-header strong {
  color: var(--color-primary-dark);
  font-size: 18px;
}

.platform-statuses {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin-top: 16px;
}

.status-item {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 9px 10px;
  border: 1px solid var(--color-border-light);
  border-radius: 9px;
  background: var(--color-surface-subtle);
  font-size: 12px;
}

.status-item > span:nth-child(2) {
  overflow: hidden;
  color: var(--color-text-secondary);
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-item small {
  color: var(--color-text-muted);
}

.status-item em {
  color: var(--color-text-muted);
  font-size: 11px;
  font-style: normal;
}

.status-item em.capturing {
  color: var(--color-primary);
}

.status-item em.completed {
  color: var(--color-success);
}

.status-item em.failed {
  color: var(--color-danger);
}

.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #aab1be;
}

.status-dot.capturing {
  background: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}

.status-dot.completed {
  background: var(--color-success);
}

.status-dot.failed {
  background: var(--color-danger);
}

@media (max-width: 960px) {
  .platform-statuses {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 540px) {
  .platform-statuses {
    grid-template-columns: 1fr;
  }
}
</style>
