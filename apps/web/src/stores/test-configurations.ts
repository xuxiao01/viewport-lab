import type {
  GetTestConfigurationResponse,
  ListTestConfigurationsResponse,
  RunKind,
  SaveTestConfigurationResponse,
  TestConfiguration,
  TestConfigurationSummary,
} from '@viewport-lab/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

function sourceKey(kind: RunKind, sourceRunId: string): string {
  return `${kind}:${sourceRunId}`
}

export const useTestConfigurationStore = defineStore('test-configurations', () => {
  const configurations = ref<TestConfigurationSummary[]>([])
  const loading = ref(false)
  const savingSourceKey = ref<string | null>(null)
  const deletingConfigId = ref<string | null>(null)
  const error = ref<string | null>(null)

  const savedSourceKeys = computed(
    () =>
      new Set(
        configurations.value.map((configuration) =>
          sourceKey(configuration.kind, configuration.sourceRunId),
        ),
      ),
  )

  async function readApiError(response: Response, fallback: string): Promise<string> {
    try {
      const payload = (await response.json()) as { error?: string }
      if (typeof payload.error === 'string') return payload.error
    } catch {
      // use fallback
    }
    return fallback
  }

  async function loadConfigurations(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const response = await fetch('/api/test-configurations')
      if (!response.ok) {
        throw new Error(await readApiError(response, '无法加载配置清单'))
      }
      configurations.value = (
        (await response.json()) as ListTestConfigurationsResponse
      ).configurations
    } catch (err) {
      error.value = err instanceof Error ? err.message : '无法加载配置清单'
    } finally {
      loading.value = false
    }
  }

  async function getConfiguration(configId: string): Promise<TestConfiguration> {
    const response = await fetch(`/api/test-configurations/${configId}`)
    if (!response.ok) {
      throw new Error(await readApiError(response, '无法加载测试配置'))
    }
    return ((await response.json()) as GetTestConfigurationResponse).configuration
  }

  async function saveConfiguration(
    kind: RunKind,
    sourceRunId: string,
    name: string,
  ): Promise<SaveTestConfigurationResponse> {
    const key = sourceKey(kind, sourceRunId)
    savingSourceKey.value = key
    error.value = null
    try {
      const response = await fetch('/api/test-configurations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceKind: kind, sourceRunId, name }),
      })
      if (!response.ok) {
        throw new Error(await readApiError(response, '加入配置清单失败'))
      }
      const result = (await response.json()) as SaveTestConfigurationResponse
      await loadConfigurations()
      return result
    } catch (err) {
      error.value = err instanceof Error ? err.message : '加入配置清单失败'
      throw err
    } finally {
      savingSourceKey.value = null
    }
  }

  async function deleteConfiguration(configId: string): Promise<void> {
    deletingConfigId.value = configId
    error.value = null
    try {
      const response = await fetch(`/api/test-configurations/${configId}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        throw new Error(await readApiError(response, '删除测试配置失败'))
      }
      configurations.value = configurations.value.filter(
        (configuration) => configuration.configId !== configId,
      )
    } catch (err) {
      error.value = err instanceof Error ? err.message : '删除测试配置失败'
      throw err
    } finally {
      deletingConfigId.value = null
    }
  }

  function hasSource(kind: RunKind, sourceRunId: string): boolean {
    return savedSourceKeys.value.has(sourceKey(kind, sourceRunId))
  }

  return {
    configurations,
    loading,
    savingSourceKey,
    deletingConfigId,
    error,
    savedSourceKeys,
    loadConfigurations,
    getConfiguration,
    saveConfiguration,
    deleteConfiguration,
    hasSource,
  }
})
