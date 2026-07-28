<script setup lang="ts">
import type { TestConfigurationSummary } from '@viewport-lab/shared'
import { ElMessage, ElMessageBox } from 'element-plus'
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'

import AppHeader from '../components/AppHeader.vue'
import { useTestConfigurationStore } from '../stores/test-configurations'

const store = useTestConfigurationStore()
const router = useRouter()
const checkingSourceKey = ref<string | null>(null)

function sourceKey(configuration: TestConfigurationSummary): string {
  return `${configuration.kind}:${configuration.sourceRunId}`
}

async function viewConfiguration(configuration: TestConfigurationSummary): Promise<void> {
  const key = sourceKey(configuration)
  checkingSourceKey.value = key
  try {
    const endpoint =
      configuration.kind === 'agent'
        ? `/api/agent/runs/${configuration.sourceRunId}`
        : `/api/batches/${configuration.sourceRunId}`
    const response = await fetch(endpoint)
    if (response.status === 404) {
      ElMessage.warning('原运行记录已删除，无法查看截图')
      return
    }
    if (!response.ok) throw new Error('无法检查原运行记录')
    await router.push({
      name: 'home',
      query: {
        kind: configuration.kind,
        runId: configuration.sourceRunId,
      },
    })
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '无法查看原运行记录')
  } finally {
    checkingSourceKey.value = null
  }
}

function runConfiguration(configuration: TestConfigurationSummary): void {
  void router.push({
    name: 'home',
    query: { configurationId: configuration.configId, autorun: '1' },
  })
}

async function deleteConfiguration(configuration: TestConfigurationSummary): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `确认删除配置“${configuration.name}”吗？原历史批次不会受到影响。`,
      '删除测试配置',
      {
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        type: 'warning',
      },
    )
  } catch {
    return
  }

  try {
    await store.deleteConfiguration(configuration.configId)
    ElMessage.success('配置已删除')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '删除测试配置失败')
  }
}

onMounted(() => {
  void store.loadConfigurations()
})
</script>

<template>
  <main class="page-shell">
    <AppHeader />
    <section class="configuration-section">
      <div class="section-heading">
        <div>
          <h2>配置清单</h2>
          <p>沉淀常用检测配置，并按保存时的设备参数快速重跑</p>
        </div>
        <span v-if="store.configurations.length > 0">
          {{ store.configurations.length }} 个配置
        </span>
      </div>

      <div v-if="store.loading" class="state-card surface-card">正在加载配置清单…</div>
      <div v-else-if="store.configurations.length === 0" class="state-card surface-card">
        <strong>暂无测试配置</strong>
        <p>{{ store.error ?? '可在截图历史中将表现良好的批次加入配置清单' }}</p>
      </div>
      <div v-else class="configuration-grid">
        <article
          v-for="configuration in store.configurations"
          :key="configuration.configId"
          class="configuration-card surface-card"
        >
          <div class="configuration-copy">
            <div class="configuration-title">
              <span class="kind-badge" :class="configuration.kind">
                {{ configuration.kind === 'agent' ? 'Agent 探索' : '视口截图' }}
              </span>
              <h3>{{ configuration.name }}</h3>
            </div>
            <p class="configuration-description">
              {{ configuration.task || configuration.url }}
            </p>
          </div>

          <footer>
            <el-button
              type="success"
              :loading="checkingSourceKey === sourceKey(configuration)"
              @click="viewConfiguration(configuration)"
            >
              查看
            </el-button>
            <el-button
              type="danger"
              :loading="store.deletingConfigId === configuration.configId"
              @click="deleteConfiguration(configuration)"
            >
              删除
            </el-button>
            <el-button type="primary" @click="runConfiguration(configuration)"> 重跑 </el-button>
          </footer>
        </article>
      </div>
    </section>
  </main>
</template>

<style scoped>
.page-shell {
  width: min(1440px, calc(100% - 48px));
  margin: 0 auto;
  padding-bottom: 64px;
}

.section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 12px;
}

.section-heading h2 {
  margin: 0;
  color: var(--color-text-strong);
  font-size: 17px;
}

.section-heading p,
.section-heading > span {
  margin: 5px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.state-card {
  display: grid;
  place-items: center;
  min-height: 220px;
  padding: 24px;
  color: var(--color-text-muted);
  text-align: center;
}

.state-card strong {
  color: var(--color-text-strong);
}

.state-card p {
  margin: 7px 0 0;
}

.configuration-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 10px;
}

.configuration-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 24px;
  min-width: 0;
  min-height: 116px;
  padding: 18px 20px;
}

.configuration-copy {
  min-width: 0;
}

.configuration-title {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.configuration-card h3 {
  overflow: hidden;
  margin: 0;
  color: var(--color-text-strong);
  font-size: 15px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kind-badge {
  flex: 0 0 auto;
  padding: 3px 7px;
  border-radius: 999px;
  color: var(--color-text-muted);
  background: var(--color-surface-subtle);
  font-size: 10px;
  font-weight: 650;
}

.kind-badge.agent {
  color: var(--color-primary-dark);
  background: var(--color-primary-soft);
}

.configuration-description {
  display: -webkit-box;
  overflow: hidden;
  margin: 12px 0 0;
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.configuration-card footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

@media (max-width: 720px) {
  .configuration-card {
    grid-template-columns: 1fr;
    gap: 14px;
    min-height: 0;
    padding: 16px;
  }

  .configuration-card footer {
    flex-wrap: wrap;
  }

  .page-shell {
    width: min(100% - 24px, 640px);
    padding-bottom: 36px;
  }
}
</style>
