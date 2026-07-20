import type {
  CreateRunRequest,
  CreateRunResponse,
  RunEvent,
  RunManifest,
} from '@viewport-lab/shared'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

const terminalStatuses = new Set(['completed', 'failed'])

export const useRunStore = defineStore('run', () => {
  const run = ref<RunManifest | null>(null)
  const submitting = ref(false)
  let eventSource: EventSource | null = null
  let pollTimer: number | null = null

  const isTerminal = computed(() => (run.value ? terminalStatuses.has(run.value.status) : false))

  function stopWatching(): void {
    eventSource?.close()
    eventSource = null
    if (pollTimer !== null) window.clearTimeout(pollTimer)
    pollTimer = null
  }

  async function fetchRun(runId: string): Promise<void> {
    const response = await fetch(`/api/runs/${runId}`)
    if (!response.ok) throw new Error('无法获取截图任务')
    run.value = (await response.json()) as RunManifest
  }

  function startPolling(runId: string): void {
    eventSource?.close()
    eventSource = null
    const poll = async (): Promise<void> => {
      try {
        await fetchRun(runId)
        if (isTerminal.value) return stopWatching()
      } catch {
        // A later poll may recover from a transient development-server restart.
      }
      pollTimer = window.setTimeout(() => void poll(), 1000)
    }
    void poll()
  }

  function watchRun(runId: string): void {
    stopWatching()
    eventSource = new EventSource(`/api/runs/${runId}/events`)
    eventSource.addEventListener('status', (message) => {
      const event = JSON.parse((message as MessageEvent<string>).data) as RunEvent
      run.value = event.run
      if (isTerminal.value) stopWatching()
    })
    eventSource.onerror = () => {
      if (!isTerminal.value) startPolling(runId)
    }
  }

  async function createRun(request: CreateRunRequest): Promise<void> {
    stopWatching()
    submitting.value = true
    run.value = null
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      })
      if (!response.ok) throw new Error('创建截图任务失败，请检查输入')
      const body = (await response.json()) as CreateRunResponse
      run.value = body.run
      watchRun(body.run.runId)
    } finally {
      submitting.value = false
    }
  }

  return { run, submitting, isTerminal, createRun }
})
