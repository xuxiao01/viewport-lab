import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AgentGatewayStatus } from '@viewport-lab/shared'

const rootDir = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
export const agentRunsDir = resolve(rootDir, 'data/agent_runs')
export const agentOutputsDir = agentRunsDir

export interface AgentGatewayConfig {
  apiUrl: string
  apiKey: string
  vhost: string
  model: string
  timeoutMs: number
}

export function readAgentGatewayConfig(): AgentGatewayConfig | null {
  const apiUrl = process.env.AGENT_GATEWAY_API_URL
  const apiKey = process.env.AGENT_GATEWAY_API_KEY
  if (!apiUrl || !apiKey) return null
  const vhost = process.env.AGENT_GATEWAY_VHOST ?? ''
  const model = process.env.AGENT_GATEWAY_MODEL ?? 'deepseek-v4-flash'
  const timeoutRaw = Number(process.env.AGENT_GATEWAY_TIMEOUT_MS ?? '120000')
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 120_000
  return { apiUrl, apiKey, vhost, model, timeoutMs }
}

export function agentGatewayStatus(): AgentGatewayStatus {
  const config = readAgentGatewayConfig()
  if (!config) {
    return {
      configured: false,
      model: null,
      vhost: null,
      reason: '未配置 AGENT_GATEWAY_API_URL 或 AGENT_GATEWAY_API_KEY',
    }
  }
  return {
    configured: true,
    model: config.model,
    vhost: config.vhost || null,
    reason: null,
  }
}
