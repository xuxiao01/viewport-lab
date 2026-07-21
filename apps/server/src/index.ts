import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'

import fastifyStatic from '@fastify/static'
import { screenshotLimits } from '@viewport-lab/shared'
import type {
  ApiErrorResponse,
  BatchManifest,
  CreateBatchResponse,
  CreateRunRequest,
  CreateRunResponse,
  HealthResponse,
  RunEvent,
  RunManifest,
} from '@viewport-lab/shared'
import Fastify from 'fastify'
import { chromium } from 'playwright'
import type { Page } from 'playwright'

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
const batchIdPattern = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}_[0-9a-f]{8}$/i
const runIdPattern = /^[0-9a-f-]{36}$/i
const outputNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function createBatchId(date: Date): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0')
  const timestamp = [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`,
  ].join('_')

  return `${timestamp}_${randomUUID().slice(0, 8)}`
}

function parseCreateRunRequest(value: unknown): CreateRunRequest | null {
  if (!isRecord(value) || !isRecord(value.viewport)) return null

  const {
    batchId,
    outputName,
    url,
    viewport,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    fullPage,
    readySelector,
  } = value
  if (
    typeof batchId !== 'string' ||
    !batchIdPattern.test(batchId) ||
    typeof outputName !== 'string' ||
    !outputNamePattern.test(outputName) ||
    typeof url !== 'string' ||
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
    batchId,
    outputName,
    url,
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor,
    isMobile,
    hasTouch,
    fullPage,
    readySelector: readySelector.trim(),
  }
}

function manifestPath(batchId: string, runId: string): string {
  return resolve(runsDir, batchId, `${runId}.manifest.json`)
}

async function persistRun(run: RunManifest): Promise<void> {
  await writeFile(
    manifestPath(run.request.batchId, run.runId),
    `${JSON.stringify(run, null, 2)}\n`,
    'utf8',
  )
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
  if (!runIdPattern.test(runId)) return null

  const batchDirectories = await readdir(runsDir, { withFileTypes: true })
  for (const entry of batchDirectories) {
    if (!entry.isDirectory() || !batchIdPattern.test(entry.name)) continue
    try {
      const contents = await readFile(manifestPath(entry.name, runId), 'utf8')
      return JSON.parse(contents) as RunManifest
    } catch {
      // Continue searching other batch directories.
    }
  }
  return null
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown screenshot error'
}

function isCaptureScreenshotError(error: unknown): boolean {
  return errorMessage(error).includes('Page.captureScreenshot')
}

async function waitForPaint(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolvePaint) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolvePaint()))
      }),
  )
}

async function captureScreenshot(
  page: Page,
  screenshotPath: string,
  fullPage: boolean,
  runId: string,
): Promise<void> {
  await waitForPaint(page)
  try {
    await page.screenshot({ path: screenshotPath, fullPage })
  } catch (error) {
    if (!isCaptureScreenshotError(error)) throw error
    app.log.warn({ err: error, runId }, 'Screenshot capture failed; retrying once')
    await waitForPaint(page)
    await page.screenshot({ path: screenshotPath, fullPage })
  }
}

async function executeRun(runId: string): Promise<void> {
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null
  try {
    const launching = await updateRun(runId, { status: 'launching' })
    browser = await chromium.launch()
    const context = await browser.newContext({
      viewport: launching.request.viewport,
      screen: launching.request.viewport,
      deviceScaleFactor: launching.request.deviceScaleFactor,
      isMobile: launching.request.isMobile,
      hasTouch: launching.request.hasTouch,
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
    const screenshotFileName = `${launching.request.outputName}.png`
    const screenshotPath = resolve(runsDir, launching.request.batchId, screenshotFileName)
    await captureScreenshot(page, screenshotPath, launching.request.fullPage, runId)
    const completedAt = new Date().toISOString()
    await updateRun(runId, {
      status: 'completed',
      completedAt,
      screenshotPath: `data/runs/${launching.request.batchId}/${screenshotFileName}`,
      screenshotUrl: `/outputs/${launching.request.batchId}/${screenshotFileName}`,
      error: null,
    })
  } catch (error) {
    try {
      await updateRun(runId, {
        status: 'failed',
        completedAt: new Date().toISOString(),
        error: errorMessage(error),
      })
    } catch (persistError) {
      app.log.error(
        { err: persistError, runId, originalError: errorMessage(error) },
        'Failed to persist run failure',
      )
    }
  } finally {
    try {
      await browser?.close()
    } catch (closeError) {
      app.log.error({ err: closeError, runId }, 'Failed to close Chromium')
    }
  }
}

await mkdir(runsDir, { recursive: true })
await app.register(fastifyStatic, { root: runsDir, prefix: '/outputs/' })

app.get<{ Reply: HealthResponse }>('/api/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
}))

app.post<{ Reply: CreateBatchResponse }>('/api/batches', async (_request, reply) => {
  const createdAt = new Date()
  const batch: BatchManifest = {
    batchId: createBatchId(createdAt),
    createdAt: createdAt.toISOString(),
  }
  const batchDirectory = resolve(runsDir, batch.batchId)
  await mkdir(batchDirectory, { recursive: true })
  await writeFile(
    resolve(batchDirectory, 'batch.json'),
    `${JSON.stringify(batch, null, 2)}\n`,
    'utf8',
  )
  return reply.code(201).send({ batch })
})

app.post<{ Body: unknown; Reply: CreateRunResponse | ApiErrorResponse }>(
  '/api/runs',
  async (request, reply) => {
    const parsed = parseCreateRunRequest(request.body)
    if (!parsed) return reply.code(400).send({ error: 'Invalid screenshot request' })

    try {
      await readFile(resolve(runsDir, parsed.batchId, 'batch.json'), 'utf8')
    } catch {
      return reply.code(400).send({ error: 'Screenshot batch does not exist' })
    }

    const createdAt = new Date()
    const runId = randomUUID()
    const now = createdAt.toISOString()
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
    runs.set(runId, run)
    await persistRun(run)
    void executeRun(runId).catch((error: unknown) => {
      app.log.error({ err: error, runId }, 'Unexpected screenshot task failure')
    })
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
