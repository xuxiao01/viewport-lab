import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'

import fastifyStatic from '@fastify/static'
import type {
  ApiErrorResponse,
  CreateRunRequest,
  CreateRunResponse,
  HealthResponse,
  RunEvent,
  RunManifest,
} from '@viewport-lab/shared'
import Fastify from 'fastify'
import { chromium } from 'playwright'

const rootDir = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const runsDir = resolve(rootDir, 'data/runs')

try {
  loadEnvFile(resolve(rootDir, '.env'))
} catch (error) {
  if (!isRecord(error) || error.code !== 'ENOENT') throw error
}

const host = process.env.SERVER_HOST ?? '127.0.0.1'
const portValue = Number(process.env.SERVER_PORT ?? 3001)
const port = Number.isInteger(portValue) && portValue > 0 ? portValue : 3001

const app = Fastify({ logger: true })
const runs = new Map<string, RunManifest>()
const subscribers = new Map<string, Set<(event: RunEvent) => void>>()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseCreateRunRequest(value: unknown): CreateRunRequest | null {
  if (!isRecord(value) || !isRecord(value.viewport)) return null

  const { url, viewport, deviceScaleFactor, fullPage, readySelector } = value
  if (
    typeof url !== 'string' ||
    typeof viewport.width !== 'number' ||
    !Number.isInteger(viewport.width) ||
    viewport.width <= 0 ||
    typeof viewport.height !== 'number' ||
    !Number.isInteger(viewport.height) ||
    viewport.height <= 0 ||
    typeof deviceScaleFactor !== 'number' ||
    !Number.isFinite(deviceScaleFactor) ||
    deviceScaleFactor <= 0 ||
    typeof fullPage !== 'boolean' ||
    typeof readySelector !== 'string'
  ) {
    return null
  }

  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null
  } catch {
    return null
  }

  return {
    url,
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor,
    fullPage,
    readySelector: readySelector.trim(),
  }
}

function manifestPath(runId: string): string {
  return resolve(runsDir, runId, 'manifest.json')
}

async function persistRun(run: RunManifest): Promise<void> {
  await writeFile(manifestPath(run.runId), `${JSON.stringify(run, null, 2)}\n`, 'utf8')
}

function publish(run: RunManifest): void {
  const event: RunEvent = { type: 'status', run }
  for (const subscriber of subscribers.get(run.runId) ?? []) subscriber(event)
}

async function updateRun(runId: string, patch: Partial<RunManifest>): Promise<RunManifest> {
  const current = runs.get(runId)
  if (!current) throw new Error(`Run ${runId} does not exist`)
  const updated: RunManifest = { ...current, ...patch, updatedAt: new Date().toISOString() }
  runs.set(runId, updated)
  await persistRun(updated)
  publish(updated)
  return updated
}

async function getRun(runId: string): Promise<RunManifest | null> {
  const memoryRun = runs.get(runId)
  if (memoryRun) return memoryRun
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return null

  try {
    const contents = await readFile(manifestPath(runId), 'utf8')
    return JSON.parse(contents) as RunManifest
  } catch {
    return null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown screenshot error'
}

async function executeRun(runId: string): Promise<void> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
  try {
    const launching = await updateRun(runId, { status: 'launching' })
    browser = await chromium.launch()
    const context = await browser.newContext({
      viewport: launching.request.viewport,
      deviceScaleFactor: launching.request.deviceScaleFactor,
    })
    const page = await context.newPage()
    page.setDefaultNavigationTimeout(30_000)
    page.setDefaultTimeout(15_000)

    await updateRun(runId, { status: 'navigating' })
    await page.goto(launching.request.url, { waitUntil: 'domcontentloaded' })

    await updateRun(runId, { status: 'waiting' })
    if (launching.request.readySelector) {
      await page.locator(launching.request.readySelector).waitFor({ state: 'visible' })
    }
    await page.waitForFunction(() => document.fonts.status === 'loaded')
    await page.waitForFunction(() => Array.from(document.images).every((image) => image.complete))

    await updateRun(runId, { status: 'capturing' })
    const screenshotPath = resolve(runsDir, runId, 'screenshot.png')
    await page.screenshot({ path: screenshotPath, fullPage: launching.request.fullPage })
    const completedAt = new Date().toISOString()
    await updateRun(runId, {
      status: 'completed',
      completedAt,
      screenshotPath: `data/runs/${runId}/screenshot.png`,
      screenshotUrl: `/outputs/${runId}/screenshot.png`,
      error: null,
    })
  } catch (error) {
    await updateRun(runId, {
      status: 'failed',
      completedAt: new Date().toISOString(),
      error: errorMessage(error),
    })
  } finally {
    await browser?.close()
  }
}

await mkdir(runsDir, { recursive: true })
await app.register(fastifyStatic, { root: runsDir, prefix: '/outputs/' })

app.get<{ Reply: HealthResponse }>('/api/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
}))

app.post<{ Body: unknown; Reply: CreateRunResponse | ApiErrorResponse }>(
  '/api/runs',
  async (request, reply) => {
    const parsed = parseCreateRunRequest(request.body)
    if (!parsed) return reply.code(400).send({ error: 'Invalid screenshot request' })

    const runId = randomUUID()
    const now = new Date().toISOString()
    const run: RunManifest = {
      runId,
      request: parsed,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      screenshotPath: null,
      screenshotUrl: null,
      error: null,
    }
    await mkdir(resolve(runsDir, runId), { recursive: true })
    runs.set(runId, run)
    await persistRun(run)
    void executeRun(runId)
    return reply.code(202).send({ run })
  },
)

app.get<{ Params: { runId: string }; Reply: RunManifest | ApiErrorResponse }>(
  '/api/runs/:runId',
  async (request, reply) => {
    const run = await getRun(request.params.runId)
    if (!run) return reply.code(404).send({ error: 'Run not found' })
    return reply.send(run)
  },
)

app.get<{ Params: { runId: string } }>('/api/runs/:runId/events', async (request, reply) => {
  const run = await getRun(request.params.runId)
  if (!run) return reply.code(404).send({ error: 'Run not found' })

  reply.hijack()
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })

  const writeEvent = (event: RunEvent): void => {
    reply.raw.write(`event: status\ndata: ${JSON.stringify(event)}\n\n`)
    if (event.run.status === 'completed' || event.run.status === 'failed') reply.raw.end()
  }

  writeEvent({ type: 'status', run })
  if (run.status === 'completed' || run.status === 'failed') return

  const runSubscribers = subscribers.get(run.runId) ?? new Set<(event: RunEvent) => void>()
  runSubscribers.add(writeEvent)
  subscribers.set(run.runId, runSubscribers)
  request.raw.on('close', () => {
    runSubscribers.delete(writeEvent)
    if (runSubscribers.size === 0) subscribers.delete(run.runId)
  })
})

try {
  await app.listen({ host, port })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
