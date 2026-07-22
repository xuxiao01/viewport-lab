import { rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import type {
  AgentGatewayStatus,
  AgentRun,
  AgentRunSummary,
  CreateAgentRunRequest,
  CreateAgentRunResponse,
  GetAgentRunResponse,
  ListAgentRunsResponse,
} from '@viewport-lab/shared'
import type { AgentEvent } from '@viewport-lab/shared'
import type { FastifyInstance } from 'fastify'

import { agentGatewayStatus, agentOutputsDir } from './config.js'
import { listAgentRuns, readAgentRun } from './recorder.js'
import { startAgentRun } from './runner.js'
import type { AgentEventSink } from './runner.js'

type Subscriber = (event: AgentEvent) => void
const subscribers = new Map<string, Set<Subscriber>>()

export function publishAgentEvent(event: AgentEvent): void {
  const runId =
    event.type === 'log' ? event.runId : event.type === 'status' ? event.run.runId : event.runId
  for (const subscriber of subscribers.get(runId) ?? []) subscriber(event)
}

const emit: AgentEventSink = publishAgentEvent

function isHttpUrl(value: string): boolean {
  try {
    const parsedUrl = new URL(value)
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:'
  } catch {
    return false
  }
}

function toRunSummary(run: AgentRun): AgentRunSummary {
  const completedDeviceCount = run.deviceRuns.filter((dr) => dr.status === 'completed').length
  const stepCount = run.deviceRuns.reduce((sum, dr) => sum + dr.steps.length, 0)
  return {
    runId: run.runId,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    status: run.status,
    url: run.url,
    task: run.task,
    deviceCount: run.devices.length,
    completedDeviceCount,
    stepCount,
    durationMs: run.durationMs,
  }
}

function parseCreateAgentRunRequest(body: unknown): CreateAgentRunRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const value = body as Record<string, unknown>
  const { url, task, note, devices, maxTurns } = value
  if (
    typeof url !== 'string' ||
    !isHttpUrl(url) ||
    typeof task !== 'string' ||
    task.trim().length === 0 ||
    typeof note !== 'string' ||
    note.length > 200 ||
    !Array.isArray(devices) ||
    devices.length === 0 ||
    devices.length > 20 ||
    typeof maxTurns !== 'number' ||
    !Number.isInteger(maxTurns) ||
    maxTurns < 1 ||
    maxTurns > 100
  ) {
    return null
  }
  return {
    url,
    task: task.trim(),
    note: note.trim(),
    devices: devices as CreateAgentRunRequest['devices'],
    maxTurns,
  }
}

const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])

function isRunTerminal(run: AgentRun): boolean {
  return terminalStatuses.has(run.status)
}

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Reply: AgentGatewayStatus }>('/api/agent/gateway-status', async () =>
    agentGatewayStatus(),
  )

  app.get<{ Reply: ListAgentRunsResponse }>('/api/agent/runs', async () => ({
    runs: (await listAgentRuns()).map(toRunSummary),
  }))

  app.get<{ Params: { runId: string }; Reply: GetAgentRunResponse | { error: string } }>(
    '/api/agent/runs/:runId',
    async (request, reply) => {
      const run = await readAgentRun(request.params.runId)
      if (!run) return reply.code(404).send({ error: 'Agent run not found' })
      return reply.send({ run })
    },
  )

  app.post<{ Body: unknown; Reply: CreateAgentRunResponse | { error: string } }>(
    '/api/agent/runs',
    async (request, reply) => {
      const parsed = parseCreateAgentRunRequest(request.body)
      if (!parsed) {
        return reply.code(400).send({ error: 'Invalid agent run request' })
      }
      const run = await startAgentRun({
        url: parsed.url,
        task: parsed.task,
        note: parsed.note,
        devices: parsed.devices,
        maxTurns: parsed.maxTurns,
        emit,
      })
      return reply.code(201).send({ run })
    },
  )

  app.delete<{ Params: { runId: string } }>('/api/agent/runs/:runId', async (request, reply) => {
    const { runId } = request.params
    const run = await readAgentRun(runId)
    if (!run) return reply.code(404).send({ error: 'Agent run not found' })
    subscribers.delete(runId)
    await rm(resolve(agentOutputsDir, runId), { recursive: true })
    return reply.code(204).send()
  })

  app.get<{ Params: { runId: string } }>(
    '/api/agent/runs/:runId/events',
    async (request, reply) => {
      const { runId } = request.params
      const run = await readAgentRun(runId)
      if (!run) return reply.code(404).send({ error: 'Agent run not found' })

      reply.hijack()
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      })

      let ended = false
      const writeEvent = (event: AgentEvent): void => {
        if (ended) return
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        if (event.type === 'status' && isRunTerminal(event.run)) {
          reply.raw.end()
          ended = true
        }
        if (event.type === 'device_completed' && isRunTerminal(event.run)) {
          reply.raw.end()
          ended = true
        }
      }

      writeEvent({ type: 'status', run })
      if (isRunTerminal(run)) {
        return
      }

      const runSubscribers = subscribers.get(runId) ?? new Set<Subscriber>()
      runSubscribers.add(writeEvent)
      subscribers.set(runId, runSubscribers)
      request.raw.on('close', () => {
        runSubscribers.delete(writeEvent)
        if (runSubscribers.size === 0) subscribers.delete(runId)
      })
    },
  )
}
