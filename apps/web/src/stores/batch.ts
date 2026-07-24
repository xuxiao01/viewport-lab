import type { AgentRun, AgentRunSummary, RetryRun, RetryRunSummary } from '@viewport-lab/shared'
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useBatchStore = defineStore('batch', () => {
  const batches = ref<AgentRunSummary[]>([])
  const loading = ref(false)
  const retrying = ref(false)
  const error = ref<string | null>(null)

  const retrySummaries = ref<Map<string, RetryRunSummary[]>>(new Map())
  const retryDetails = ref<Map<string, RetryRun>>(new Map())
  const selectedRunId = ref<string | null>(null)
  const selectedRetryId = ref<string | null>(null)
  const currentAgentRun = ref<AgentRun | null>(null)

  async function loadBatches(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const response = await fetch('/api/agent/runs')
      if (!response.ok) throw new Error('无法加载批次列表')
      const data = (await response.json()) as { runs: AgentRunSummary[] }
      batches.value = data.runs
      const completed = data.runs.filter((b) => b.status === 'completed')
      await Promise.allSettled(completed.map((b) => loadRetries(b.runId)))
    } catch (err) {
      error.value = err instanceof Error ? err.message : '无法加载批次列表'
    } finally {
      loading.value = false
    }
  }

  async function loadRetries(runId: string): Promise<void> {
    try {
      const response = await fetch(`/api/agent/runs/${runId}/retries`)
      if (!response.ok) throw new Error('无法加载重试列表')
      const data = (await response.json()) as { retries: RetryRunSummary[] }
      retrySummaries.value.set(runId, data.retries)
    } catch {
      retrySummaries.value.set(runId, [])
    }
  }

  async function loadRetryDetail(runId: string, retryId: string): Promise<void> {
    try {
      const response = await fetch(`/api/agent/runs/${runId}/retries/${retryId}`)
      if (!response.ok) throw new Error('无法加载重试详情')
      const data = (await response.json()) as { retry: RetryRun }
      retryDetails.value.set(retryId, data.retry)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '无法加载重试详情'
    }
  }

  async function loadAgentRun(runId: string): Promise<void> {
    try {
      const response = await fetch(`/api/agent/runs/${runId}`)
      if (!response.ok) throw new Error('无法加载 Agent 运行详情')
      const data = (await response.json()) as { run: AgentRun }
      currentAgentRun.value = data.run
    } catch {
      currentAgentRun.value = null
    }
  }

  async function selectBatch(runId: string): Promise<void> {
    selectedRunId.value = runId
    selectedRetryId.value = null
    await Promise.all([loadRetries(runId), loadAgentRun(runId)])
  }

  async function selectRetry(runId: string, retryId: string): Promise<void> {
    selectedRetryId.value = retryId
    if (!retryDetails.value.has(retryId)) {
      await loadRetryDetail(runId, retryId)
    }
  }

  async function retryBatch(runId: string): Promise<void> {
    retrying.value = true
    error.value = null
    selectedRunId.value = runId

    try {
      await loadAgentRun(runId)
      const response = await fetch(`/api/agent/runs/${runId}/retry`, {
        method: 'POST',
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({ error: '请求失败' }))) as {
          error?: string
        }
        throw new Error(body.error ?? '重试请求失败')
      }
      const data = (await response.json()) as { retry: RetryRun }
      retryDetails.value.set(data.retry.retryId, data.retry)
      await loadRetries(runId)
      await selectRetry(runId, data.retry.retryId)
    } catch (err) {
      error.value = err instanceof Error ? err.message : '重试失败'
    } finally {
      retrying.value = false
    }
  }

  return {
    batches,
    loading,
    retrying,
    error,
    retrySummaries,
    retryDetails,
    selectedRunId,
    selectedRetryId,
    currentAgentRun,
    loadBatches,
    loadRetries,
    loadRetryDetail,
    selectBatch,
    selectRetry,
    retryBatch,
  }
})
