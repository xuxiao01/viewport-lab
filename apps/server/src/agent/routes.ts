import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

import type {
  AgentGatewayStatus,
  AgentRun,
  AgentRunSummary,
  CreateAgentRunRequest,
  CreateAgentRunResponse,
  CreateRetryRunResponse,
  GetAgentRunResponse,
  GetRetryRunResponse,
  ListAgentRunsResponse,
  ListRetryRunsResponse,
  RerunAgentRunRequest,
  RerunAgentRunResponse,
  RetryDeviceResult,
  RetryRun,
  RetryScreenshot,
  ScreenshotDevicePresetSnapshot,
  OptimizeAgentTaskPromptRequest,
  OptimizeAgentTaskPromptResponse,
  UpdateAgentRerunListRequest,
  UpdateAgentRerunListResponse,
  UpdateRunNoteRequest,
} from '@viewport-lab/shared'
import {
  agentModelNames,
  agentTurnLimits,
  defaultAgentModel,
  batchNoteMaxLength,
  captureDelayValues,
  screenshotLimits,
  screenshotPlatformIds,
  taskPromptOptimizationLimits,
} from '@viewport-lab/shared'
import type { AgentEvent } from '@viewport-lab/shared'
import type { FastifyInstance } from 'fastify'

import { agentGatewayStatus, agentOutputsDir, agentRunsDir, readAgentGatewayConfig } from './config.js'
import {
  ensureRetryDeviceDir,
  listAgentRuns,
  listRetryRuns,
  listRetryScreenshots,
  readAgentRun,
  readRetryRun,
  sanitizeDeviceDir,
  updateAgentRerunList,
  updateAgentRunNote,
  writeRetryRun,
} from './recorder.js'
import { cancelAgentRun, rerunAgentRunInPlace, startAgentRun } from './runner.js'
import type { AgentEventSink } from './runner.js'
import { optimizeAgentTaskPrompt } from './task-prompt-optimizer.js'

type Subscriber = (event: AgentEvent) => void
const subscribers = new Map<string, Set<Subscriber>>()

export function publishAgentEvent(event: AgentEvent): void {
  const runId =
    event.type === 'log' ? event.runId : event.type === 'status' ? event.run.runId : event.runId
  for (const subscriber of subscribers.get(runId) ?? []) subscriber(event)
}

const emit: AgentEventSink = publishAgentEvent

const outputNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/
const selectionIdPattern = /^[a-z0-9][a-z0-9:-]{0,127}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isHttpUrl(value: string): boolean {
  try {
    const parsedUrl = new URL(value)
    return parsedUrl.protocol === 'http:' || parsedUrl.protocol === 'https:'
  } catch {
    return false
  }
}

function parseAgentDevice(value: unknown): ScreenshotDevicePresetSnapshot | null {
  if (!isRecord(value) || !isRecord(value.viewport)) return null
  const {
    selectionId,
    platformId,
    platformName,
    presetId,
    presetName,
    viewport,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    fullPage,
    readySelector,
    captureDelayMs,
  } = value
  if (
    typeof selectionId !== 'string' ||
    !selectionIdPattern.test(selectionId) ||
    typeof platformId !== 'string' ||
    !screenshotPlatformIds.includes(platformId as (typeof screenshotPlatformIds)[number]) ||
    typeof platformName !== 'string' ||
    platformName.trim().length === 0 ||
    typeof presetId !== 'string' ||
    !outputNamePattern.test(presetId) ||
    typeof presetName !== 'string' ||
    presetName.trim().length === 0 ||
    typeof viewport.width !== 'number' ||
    !Number.isInteger(viewport.width) ||
    viewport.width < screenshotLimits.viewport.min ||
    viewport.width > screenshotLimits.viewport.max ||
    typeof viewport.height !== 'number' ||
    !Number.isInteger(viewport.height) ||
    viewport.height < screenshotLimits.viewport.min ||
    viewport.height > screenshotLimits.viewport.max ||
    typeof deviceScaleFactor !== 'number' ||
    !Number.isFinite(deviceScaleFactor) ||
    deviceScaleFactor < screenshotLimits.deviceScaleFactor.min ||
    deviceScaleFactor > screenshotLimits.deviceScaleFactor.max ||
    typeof isMobile !== 'boolean' ||
    typeof hasTouch !== 'boolean' ||
    typeof fullPage !== 'boolean' ||
    typeof readySelector !== 'string' ||
    !captureDelayValues.includes(captureDelayMs as (typeof captureDelayValues)[number])
  ) {
    return null
  }

  return {
    selectionId,
    platformId: platformId as ScreenshotDevicePresetSnapshot['platformId'],
    platformName: platformName.trim(),
    presetId,
    presetName: presetName.trim(),
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor,
    isMobile,
    hasTouch,
    fullPage,
    readySelector: readySelector.trim(),
    captureDelayMs: captureDelayMs as ScreenshotDevicePresetSnapshot['captureDelayMs'],
  }
}

function toRunSummary(run: AgentRun): AgentRunSummary {
  const completedDeviceCount = run.deviceRuns.filter((dr) => dr.status === 'completed').length
  const failedDeviceCount = run.deviceRuns.filter((dr) => dr.status === 'failed').length
  const stepCount = run.deviceRuns.reduce((sum, dr) => sum + dr.steps.length, 0)
  return {
    kind: 'agent',
    executionMode: run.executionMode,
    leaderDeviceId: run.leaderDeviceId,
    runId: run.runId,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    status: run.status,
    url: run.url,
    task: run.task,
    note: run.note,
    model: run.model,
    deviceCount: run.devices.length,
    completedDeviceCount,
    failedDeviceCount,
    stepCount,
    durationMs: run.durationMs,
  }
}

function parseCreateAgentRunRequest(body: unknown): CreateAgentRunRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const value = body as Record<string, unknown>
  const { url, task, note, devices, maxTurns, model } = value
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
    maxTurns < agentTurnLimits.min ||
    maxTurns > agentTurnLimits.max ||
    (model !== undefined &&
      (typeof model !== 'string' ||
        !agentModelNames.includes(model as (typeof agentModelNames)[number])))
  ) {
    return null
  }
  const parsedDevices = devices.map(parseAgentDevice)
  if (parsedDevices.some((device) => device === null)) return null
  const validDevices = parsedDevices.filter(
    (device): device is ScreenshotDevicePresetSnapshot => device !== null,
  )
  if (new Set(validDevices.map((device) => device.selectionId)).size !== validDevices.length) {
    return null
  }
  return {
    url,
    task: task.trim(),
    note: note.trim(),
    devices: validDevices,
    maxTurns,
    model: (model ?? defaultAgentModel) as CreateAgentRunRequest['model'],
  }
}

function parseOptimizeAgentTaskPromptRequest(body: unknown): OptimizeAgentTaskPromptRequest | null {
  if (!isRecord(body)) return null
  const { url, note, task, model, clarifications } = body
  if (
    typeof url !== 'string' ||
    !isHttpUrl(url) ||
    typeof note !== 'string' ||
    note.trim().length > batchNoteMaxLength ||
    typeof task !== 'string' ||
    task.trim().length === 0 ||
    task.trim().length > taskPromptOptimizationLimits.taskMaxLength ||
    typeof model !== 'string' ||
    !agentModelNames.includes(model as (typeof agentModelNames)[number]) ||
    !Array.isArray(clarifications) ||
    clarifications.length > taskPromptOptimizationLimits.clarificationMaxCount
  ) {
    return null
  }
  const parsedClarifications = clarifications.map((clarification) => {
    if (!isRecord(clarification)) return null
    if (typeof clarification.question !== 'string' || typeof clarification.answer !== 'string') {
      return null
    }
    const question = clarification.question.trim()
    const answer = clarification.answer.trim()
    if (
      question.length === 0 ||
      answer.length === 0 ||
      question.length > taskPromptOptimizationLimits.clarificationTextMaxLength ||
      answer.length > taskPromptOptimizationLimits.clarificationTextMaxLength
    ) {
      return null
    }
    return { question, answer }
  })
  if (parsedClarifications.some((clarification) => clarification === null)) return null
  return {
    url: url.trim(),
    note: note.trim(),
    task: task.trim(),
    model: model as OptimizeAgentTaskPromptRequest['model'],
    clarifications: parsedClarifications.filter(
      (clarification): clarification is OptimizeAgentTaskPromptRequest['clarifications'][number] =>
        clarification !== null,
    ),
  }
}

const terminalStatuses = new Set(['completed', 'partial', 'failed', 'cancelled'])

function isRunTerminal(run: AgentRun): boolean {
  return terminalStatuses.has(run.status)
}

async function retryRunSpecs(runId: string): Promise<RetryRun> {
  const retryId = randomUUID()
  const startedAt = new Date().toISOString()
  const runDir = resolve(agentRunsDir, runId, 'agent')
  const projectRoot = resolve(agentRunsDir, '..', '..')
  const configPath = resolve(projectRoot, 'playwright.config.ts')
  const deviceResults: RetryDeviceResult[] = []

  let entries: { name: string; isDirectory: () => boolean }[]
  try {
    const raw = await readdir(runDir, { withFileTypes: true })
    entries = raw.filter((e) => e.isDirectory() && e.name !== 'retries')
  } catch {
    const retry: RetryRun = {
      retryId,
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      status: 'failed',
      deviceResults: [],
      error: `Run ${runId} 目录不存在`,
    }
    await writeRetryRun(retry)
    return retry
  }

  const deviceMetaMap = new Map<string, { presetName: string; platformName: string }>()
  try {
    const run = await readAgentRun(runId)
    if (run) {
      for (const dr of run.deviceRuns) {
        deviceMetaMap.set(sanitizeDeviceDir(dr.deviceId), {
          presetName: dr.presetName,
          platformName: run.devices.find((d) => d.selectionId === dr.deviceId)?.platformName ?? '',
        })
      }
    }
  } catch {
    // fallback to directory name
  }

  for (const entry of entries) {
    const safeDeviceId = entry.name
    const specPath = resolve(runDir, safeDeviceId, 'agent.spec.ts')
    const meta = deviceMetaMap.get(safeDeviceId) ?? {
      presetName: safeDeviceId,
      platformName: '',
    }

    try {
      const { access } = await import('node:fs/promises')
      await access(specPath)
    } catch {
      deviceResults.push({
        deviceId: safeDeviceId,
        presetName: meta.presetName,
        platformName: meta.platformName,
        specPath,
        status: 'skipped',
        output: null,
        durationMs: null,
        error: null,
        screenshots: [],
      })
      continue
    }

    const retryDeviceDir = await ensureRetryDeviceDir(runId, retryId, safeDeviceId)

    const deviceStartedAt = Date.now()
    let status: 'passed' | 'failed' = 'passed'
    let output: string | null = null
    let errorMsg: string | null = null

    try {
      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>(
        (resolveP, rejectP) => {
          execFile(
            'npx',
            ['playwright', 'test', specPath, `--config=${configPath}`],
            {
              cwd: retryDeviceDir,
              timeout: 120_000,
              maxBuffer: 1024 * 1024 * 2,
              encoding: 'utf8',
            },
            (err, stdout, stderr) => {
              if (err) {
                rejectP(err)
              } else {
                resolveP({ stdout: stdout as string, stderr: stderr as string })
              }
            },
          )
        },
      )
      output = `${stdout}\n${stderr}`.trim().slice(0, 8000)
    } catch (err) {
      status = 'failed'
      const message = err instanceof Error ? err.message : String(err)
      output = message.slice(0, 8000)
      errorMsg = message.slice(0, 500)
    }

    const shotFiles = await listRetryScreenshots(runId, retryId, safeDeviceId)
    const screenshots: RetryScreenshot[] = shotFiles.map((fname) => {
      const stepIndex = parseInt(fname.replace('.png', ''), 10) || 0
      return {
        stepIndex,
        url: `/outputs/${runId}/agent/retries/${retryId}/${safeDeviceId}/screenshots/${fname}`,
      }
    })

    deviceResults.push({
      deviceId: safeDeviceId,
      presetName: meta.presetName,
      platformName: meta.platformName,
      specPath,
      status,
      output,
      durationMs: Date.now() - deviceStartedAt,
      error: errorMsg,
      screenshots,
    })
  }

  const hasFailures = deviceResults.some((d) => d.status === 'failed')
  const retry: RetryRun = {
    retryId,
    runId,
    startedAt,
    completedAt: new Date().toISOString(),
    status: hasFailures ? 'failed' : 'completed',
    deviceResults,
    error: null,
  }
  await writeRetryRun(retry)
  return retry
}

export async function registerAgentRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Reply: AgentGatewayStatus }>('/api/agent/gateway-status', async () =>
    agentGatewayStatus(),
  )

  app.post<{
    Body: unknown
    Reply: OptimizeAgentTaskPromptResponse | { error: string }
  }>('/api/agent/task-prompt-optimizer', async (request, reply) => {
    const parsed = parseOptimizeAgentTaskPromptRequest(request.body)
    if (!parsed) return reply.code(400).send({ error: 'Invalid task prompt optimization request' })
    const gatewayConfig = readAgentGatewayConfig()
    if (!gatewayConfig) return reply.code(503).send({ error: 'AI 网关未配置' })
    try {
      const result = await optimizeAgentTaskPrompt(gatewayConfig, parsed)
      return reply.send({ result })
    } catch (error) {
      return reply
        .code(502)
        .send({ error: error instanceof Error ? error.message : 'AI 任务描述优化失败' })
    }
  })

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

  app.patch<{
    Params: { runId: string }
    Body: unknown
    Reply: GetAgentRunResponse | { error: string }
  }>('/api/agent/runs/:runId', async (request, reply) => {
    const body = request.body as Partial<UpdateRunNoteRequest> | null
    if (typeof body?.note !== 'string' || body.note.trim().length > batchNoteMaxLength) {
      return reply.code(400).send({ error: 'Invalid task title' })
    }
    const run = await updateAgentRunNote(request.params.runId, body.note.trim())
    if (!run) return reply.code(404).send({ error: 'Agent run not found' })
    publishAgentEvent({ type: 'status', run })
    return reply.send({ run })
  })

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
        model: parsed.model,
        emit,
      })
      return reply.code(201).send({ run })
    },
  )

  app.put<{
    Params: { runId: string }
    Body: unknown
    Reply: UpdateAgentRerunListResponse | { error: string }
  }>('/api/agent/runs/:runId/rerun-list', async (request, reply) => {
    const body = request.body as Partial<UpdateAgentRerunListRequest> | null
    if (
      typeof body?.deviceId !== 'string' ||
      body.deviceId.length === 0 ||
      typeof body.included !== 'boolean'
    ) {
      return reply.code(400).send({ error: 'Invalid rerun list request' })
    }
    const run = await readAgentRun(request.params.runId)
    if (!run) return reply.code(404).send({ error: 'Agent run not found' })
    if (!isRunTerminal(run)) {
      return reply.code(409).send({ error: '运行中的 Agent 批次不能修改重跑清单' })
    }
    if (!run.deviceRuns.some((deviceRun) => deviceRun.deviceId === body.deviceId)) {
      return reply.code(404).send({ error: 'Agent 设备不存在' })
    }
    const rerunDeviceIds = await updateAgentRerunList(run, body.deviceId, body.included)
    return reply.send({ rerunDeviceIds })
  })

  app.post<{
    Params: { runId: string }
    Body: unknown
    Reply: RerunAgentRunResponse | { error: string }
  }>('/api/agent/runs/:runId/rerun', async (request, reply) => {
    const body = request.body as Partial<RerunAgentRunRequest> | null
    const scope = body?.scope
    if (scope !== 'all' && scope !== 'failed' && scope !== 'list') {
      return reply.code(400).send({ error: 'Invalid rerun scope' })
    }
    const sourceRun = await readAgentRun(request.params.runId)
    if (!sourceRun) return reply.code(404).send({ error: 'Agent run not found' })
    if (!isRunTerminal(sourceRun)) {
      return reply.code(409).send({ error: '运行中的 Agent 批次不能重跑' })
    }
    try {
      const result = await rerunAgentRunInPlace({ sourceRun, scope, emit })
      return reply.send(result)
    } catch (error) {
      return reply
        .code(409)
        .send({ error: error instanceof Error ? error.message : '重跑 Agent 批次失败' })
    }
  })

  app.delete<{ Params: { runId: string } }>('/api/agent/runs/:runId', async (request, reply) => {
    const { runId } = request.params
    const run = await readAgentRun(runId)
    if (!run) return reply.code(404).send({ error: 'Agent run not found' })
    if (!isRunTerminal(run)) await cancelAgentRun(runId)
    subscribers.delete(runId)
    await rm(resolve(agentOutputsDir, runId), { recursive: true })
    return reply.code(204).send()
  })

  app.get<{ Params: { runId: string }; Reply: ListRetryRunsResponse }>(
    '/api/agent/runs/:runId/retries',
    async (request) => ({
      retries: await listRetryRuns(request.params.runId),
    }),
  )

  app.get<{
    Params: { runId: string; retryId: string }
    Reply: GetRetryRunResponse | { error: string }
  }>('/api/agent/runs/:runId/retries/:retryId', async (request, reply) => {
    const retry = await readRetryRun(request.params.runId, request.params.retryId)
    if (!retry) return reply.code(404).send({ error: 'Retry run not found' })
    return reply.send({ retry })
  })

  app.post<{ Params: { runId: string }; Reply: CreateRetryRunResponse | { error: string } }>(
    '/api/agent/runs/:runId/retry',
    async (request, reply) => {
      const result = await retryRunSpecs(request.params.runId)
      return reply.code(201).send({ retry: result })
    },
  )

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
