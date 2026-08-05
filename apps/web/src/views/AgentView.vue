<script setup lang="ts">
import { agentTurnLimits, defaultAgentModel } from '@viewport-lab/shared'
import { ElMessage } from 'element-plus'
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

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
const router = useRouter()
const url = ref('http://localhost:5188')
const task = ref('')
const note = ref('')
const maxTurns = ref(agentTurnLimits.default)
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
  const run = await store.createRun({
    url: url.value.trim(),
    task: task.value.trim(),
    note: note.value.trim(),
    selectedPresetIds: effectiveSelectedPresetIds.value,
    maxTurns: maxTurns.value,
    model: defaultAgentModel,
  })
  if (!run) {
    ElMessage.error(store.error ?? '创建 Agent 运行失败')
    return
  }
  await router.push({ name: 'home', query: { kind: 'agent', runId: run.runId } })
}

onMounted(() => {
  void store.loadGatewayStatus()
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
          <el-input-number
            v-model="maxTurns"
            :min="agentTurnLimits.min"
            :max="agentTurnLimits.max"
          />
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
  color: var(--color-text-strong);
  font-size: 18px;
}

.gateway-ok,
.gateway-warn {
  margin: 0 0 14px;
  font-size: 13px;
}

.gateway-ok {
  color: var(--color-success);
}

.gateway-warn {
  color: var(--color-text-muted);
}

.form-row {
  display: grid;
  gap: 6px;
  margin-bottom: 14px;
}

.form-row label {
  color: var(--color-text-secondary);
  font-size: 13px;
  font-weight: 600;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 4px;
}

@media (max-width: 720px) {
  .page-shell {
    width: min(100% - 24px, 640px);
    padding-bottom: 36px;
  }

  .panel {
    padding: 16px;
  }
}
</style>
