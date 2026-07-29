import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'

import fastifyStatic from '@fastify/static'
import {
  batchNoteMaxLength,
  captureDelayValues,
  screenshotLimits,
  screenshotPlatformIds,
} from '@viewport-lab/shared'
import type {
  ApiErrorResponse,
  BatchManifest,
  BatchSummary,
  CaptureDelayMs,
  CreateBatchRequest,
  CreateBatchResponse,
  CreateRunRequest,
  CreateRunResponse,
  HealthResponse,
  ListBatchesResponse,
  RerunBatchRequest,
  RerunBatchResponse,
  RunEvent,
  RunManifest,
  ScreenshotDevicePresetSnapshot,
  ScreenshotDeviceRun,
  UpdateRunNoteRequest,
} from '@viewport-lab/shared'
import Fastify from 'fastify'
import { chromium } from 'playwright'
import type { Page } from 'playwright'

import { registerAgent } from './agent/index.js'
import { normalizeInterruptedAgentRuns } from './agent/recorder.js'
import { registerFontCheck } from './font-check.js'
import { archiveIdPattern, createArchiveId } from './run-archive.js'
import { SerialBatchScheduler } from './task-scheduler.js'
import { registerTestConfigurationRoutes } from './test-configurations.js'

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
const batches = new Map<string, BatchManifest>()
const batchWriteQueues = new Map<string, Promise<void>>()
const batchUpdateQueues = new Map<string, Promise<void>>()
const subscribers = new Map<string, Set<(event: RunEvent) => void>>()
const viewportBatchScheduler = new SerialBatchScheduler()
const runIdPattern = /^[0-9a-f-]{36}$/i
const outputNamePattern = /^[a-z0-9][a-z0-9-]{0,63}$/
const selectionIdPattern = /^[a-z0-9][a-z0-9:-]{0,127}$/
const runRegistrationTimeout = 15_000
const readinessTiming = {
  networkIdleTimeout: 8_000,
  domQuietTime: 700,
  domStabilityTimeout: 5_000,
  domPollInterval: 150,
  finalSettleTime: 750,
} as const

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

function isCaptureDelayMs(value: unknown): value is CaptureDelayMs {
  return typeof value === 'number' && captureDelayValues.includes(value as CaptureDelayMs)
}

function parseDeviceSnapshot(value: unknown): ScreenshotDevicePresetSnapshot | null {
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
    !isCaptureDelayMs(captureDelayMs)
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
    captureDelayMs,
  }
}

function parseCreateBatchRequest(value: unknown): CreateBatchRequest | null {
  if (!isRecord(value)) return null
  const { url, note, captureDelayMs, devices } = value
  if (
    typeof url !== 'string' ||
    !isHttpUrl(url) ||
    typeof note !== 'string' ||
    note.trim().length > batchNoteMaxLength ||
    !isCaptureDelayMs(captureDelayMs) ||
    !Array.isArray(devices) ||
    devices.length === 0 ||
    devices.length > 100
  ) {
    return null
  }
  const parsedDevices = devices.map(parseDeviceSnapshot)
  if (parsedDevices.some((device) => device === null)) return null
  const validDevices = parsedDevices.filter(
    (device): device is ScreenshotDevicePresetSnapshot => device !== null,
  )
  if (new Set(validDevices.map((device) => device.selectionId)).size !== validDevices.length) {
    return null
  }
  if (validDevices.some((device) => device.captureDelayMs !== captureDelayMs)) return null
  return { url, note: note.trim(), captureDelayMs, devices: validDevices }
}

function parseCreateRunRequest(value: unknown): CreateRunRequest | null {
  if (!isRecord(value) || !isRecord(value.viewport)) return null

  const {
    batchId,
    selectionId,
    outputName,
    url,
    viewport,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    fullPage,
    readySelector,
    captureDelayMs,
  } = value
  if (
    typeof batchId !== 'string' ||
    !archiveIdPattern.test(batchId) ||
    typeof selectionId !== 'string' ||
    !selectionIdPattern.test(selectionId) ||
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
    typeof readySelector !== 'string' ||
    !isCaptureDelayMs(captureDelayMs)
  ) {
    return null
  }

  if (!isHttpUrl(url)) return null

  return {
    batchId,
    selectionId,
    outputName,
    url,
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor,
    isMobile,
    hasTouch,
    fullPage,
    readySelector: readySelector.trim(),
    captureDelayMs,
  }
}

function batchManifestPath(batchId: string): string {
  return resolve(runsDir, batchId, 'manifest.json')
}

function isTerminalRunStatus(status: RunManifest['status']): boolean {
  return status === 'completed' || status === 'failed'
}

function isTerminalBatchStatus(status: BatchManifest['status']): boolean {
  return status === 'completed' || status === 'partial_failed' || status === 'failed'
}

function aggregateBatch(batch: BatchManifest, now: string): BatchManifest {
  const successCount = batch.devices.filter((device) => device.status === 'completed').length
  const failedCount = batch.devices.filter((device) => device.status === 'failed').length
  const terminalCount = successCount + failedCount
  let status: BatchManifest['status'] = 'running'
  if (batch.devices.every((device) => device.status === 'queued')) status = 'queued'
  if (terminalCount === batch.deviceCount) {
    if (failedCount === 0) status = 'completed'
    else if (successCount === 0) status = 'failed'
    else status = 'partial_failed'
  }
  const completedAt = isTerminalBatchStatus(status) ? (batch.completedAt ?? now) : null
  return {
    ...batch,
    status,
    updatedAt: now,
    completedAt,
    durationMs: completedAt
      ? Math.max(0, new Date(completedAt).getTime() - new Date(batch.createdAt).getTime())
      : null,
    successCount,
    failedCount,
  }
}

async function persistBatch(batch: BatchManifest): Promise<void> {
  const snapshot = `${JSON.stringify(batch, null, 2)}\n`
  const previous = batchWriteQueues.get(batch.batchId) ?? Promise.resolve()
  const next = previous
    .catch(() => undefined)
    .then(() => writeFile(batchManifestPath(batch.batchId), snapshot, 'utf8'))
  batchWriteQueues.set(batch.batchId, next)
  try {
    await next
  } finally {
    if (batchWriteQueues.get(batch.batchId) === next) batchWriteQueues.delete(batch.batchId)
  }
}

async function readBatch(batchId: string): Promise<BatchManifest | null> {
  const memoryBatch = batches.get(batchId)
  if (memoryBatch) return memoryBatch
  if (!archiveIdPattern.test(batchId)) return null
  try {
    const contents = await readFile(batchManifestPath(batchId), 'utf8')
    const parsed = JSON.parse(contents) as { kind?: string }
    if (parsed.kind === 'agent') return null
    const batch: BatchManifest = {
      ...(parsed as unknown as Omit<BatchManifest, 'kind'>),
      kind: 'viewport',
    }
    if (batch.batchId !== batchId || !Array.isArray(batch.devices)) return null
    batches.set(batchId, batch)
    return batch
  } catch {
    return null
  }
}

function toBatchSummary(batch: BatchManifest): BatchSummary {
  const {
    batchId,
    createdAt,
    completedAt,
    url,
    note,
    captureDelayMs,
    status,
    durationMs,
    deviceCount,
    successCount,
    failedCount,
  } = batch
  return {
    kind: 'viewport',
    batchId,
    createdAt,
    completedAt,
    url,
    note,
    captureDelayMs: captureDelayMs ?? 0,
    status,
    durationMs,
    deviceCount,
    successCount,
    failedCount,
  }
}

async function listBatches(): Promise<BatchManifest[]> {
  const entries = await readdir(runsDir, { withFileTypes: true })
  const loaded = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && archiveIdPattern.test(entry.name))
      .map((entry) => readBatch(entry.name)),
  )
  return loaded
    .filter((batch): batch is BatchManifest => batch !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

function deviceFromRun(batch: BatchManifest, run: RunManifest): ScreenshotDeviceRun {
  const snapshot = batch.devices.find((device) => device.selectionId === run.request.selectionId)
  if (!snapshot) throw new Error(`Device ${run.request.selectionId} does not exist`)
  return {
    ...snapshot,
    runId: run.runId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    screenshotPath: run.screenshotPath,
    screenshotUrl: run.screenshotUrl,
    error: run.error,
  }
}

function runFromDevice(batch: BatchManifest, device: ScreenshotDeviceRun): RunManifest | null {
  if (!device.runId) return null
  return {
    runId: device.runId,
    request: {
      batchId: batch.batchId,
      selectionId: device.selectionId,
      outputName: device.presetId,
      url: batch.url,
      viewport: device.viewport,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      fullPage: device.fullPage,
      readySelector: device.readySelector,
      captureDelayMs: device.captureDelayMs ?? batch.captureDelayMs ?? 0,
    },
    status: device.status,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    completedAt: device.completedAt,
    screenshotPath: device.screenshotPath,
    screenshotUrl: device.screenshotUrl,
    error: device.error,
  }
}

async function enqueueBatchUpdate(batchId: string, operation: () => Promise<void>): Promise<void> {
  const previous = batchUpdateQueues.get(batchId) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  batchUpdateQueues.set(batchId, next)
  try {
    await next
  } finally {
    if (batchUpdateQueues.get(batchId) === next) batchUpdateQueues.delete(batchId)
  }
}

async function updateBatchForRun(run: RunManifest): Promise<void> {
  const batchId = run.request.batchId
  await enqueueBatchUpdate(batchId, async () => {
    const batch = await readBatch(batchId)
    if (!batch) throw new Error(`Batch ${batchId} does not exist`)
    const deviceIndex = batch.devices.findIndex(
      (device) => device.selectionId === run.request.selectionId,
    )
    if (deviceIndex < 0) throw new Error(`Device ${run.request.selectionId} does not exist`)
    const devices = [...batch.devices]
    devices[deviceIndex] = deviceFromRun(batch, run)
    const updated = aggregateBatch({ ...batch, devices, completedAt: null }, run.updatedAt)
    batches.set(batch.batchId, updated)
    await persistBatch(updated)
  })
}

async function failUnregisteredDevices(batchId: string): Promise<void> {
  try {
    await enqueueBatchUpdate(batchId, async () => {
      const batch = await readBatch(batchId)
      if (!batch || isTerminalBatchStatus(batch.status)) return
      const failedAt = new Date().toISOString()
      let changed = false
      const devices = batch.devices.map<ScreenshotDeviceRun>((device) => {
        if (device.runId) return device
        changed = true
        return {
          ...device,
          status: 'failed',
          updatedAt: failedAt,
          completedAt: failedAt,
          error: '截图任务未能在限定时间内启动',
        }
      })
      if (!changed) return
      const updated = aggregateBatch({ ...batch, devices, completedAt: null }, failedAt)
      batches.set(batchId, updated)
      await persistBatch(updated)
    })
  } finally {
    viewportBatchScheduler.seal(batchId)
  }
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
  await updateBatchForRun(updated)
  publish(updated)
  return updated
}

async function getRun(runId: string): Promise<RunManifest | null> {
  const memoryRun = runs.get(runId)
  if (memoryRun) return memoryRun
  if (!runIdPattern.test(runId)) return null

  for (const batch of await listBatches()) {
    const device = batch.devices.find((item) => item.runId === runId)
    if (device) return runFromDevice(batch, device)
  }
  return null
}

function requestMatchesDevice(
  request: CreateRunRequest,
  batch: BatchManifest,
  device: ScreenshotDeviceRun,
): boolean {
  return (
    request.url === batch.url &&
    request.outputName === device.presetId &&
    request.viewport.width === device.viewport.width &&
    request.viewport.height === device.viewport.height &&
    request.deviceScaleFactor === device.deviceScaleFactor &&
    request.isMobile === device.isMobile &&
    request.hasTouch === device.hasTouch &&
    request.fullPage === device.fullPage &&
    request.readySelector === device.readySelector &&
    request.captureDelayMs === (device.captureDelayMs ?? batch.captureDelayMs ?? 0)
  )
}

async function normalizeInterruptedBatches(): Promise<void> {
  const interruptedAt = new Date().toISOString()
  for (const batch of await listBatches()) {
    if (isTerminalBatchStatus(batch.status)) continue
    const devices = batch.devices.map<ScreenshotDeviceRun>((device) => {
      if (isTerminalRunStatus(device.status)) return device
      return {
        ...device,
        status: 'failed',
        updatedAt: interruptedAt,
        completedAt: interruptedAt,
        error: '截图服务已重启，任务未能完成',
      }
    })
    const updated = aggregateBatch({ ...batch, devices, completedAt: null }, interruptedAt)
    batches.set(batch.batchId, updated)
    await persistBatch(updated)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown screenshot error'
}

function isCaptureScreenshotError(error: unknown): boolean {
  return errorMessage(error).includes('Page.captureScreenshot')
}

function safeResourceUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return value
  }
}

function observePageFailures(page: Page, runId: string): void {
  page.on('pageerror', (error) => {
    app.log.warn({ err: error, runId }, 'Target page script error')
  })
  page.on('requestfailed', (request) => {
    app.log.warn(
      {
        runId,
        method: request.method(),
        resourceType: request.resourceType(),
        url: safeResourceUrl(request.url()),
        failure: request.failure()?.errorText ?? 'Unknown request failure',
      },
      'Target page request failed',
    )
  })
  page.on('response', (response) => {
    if (response.status() < 400) return
    app.log.warn(
      {
        runId,
        status: response.status(),
        url: safeResourceUrl(response.url()),
      },
      'Target page returned an error response',
    )
  })
}

async function waitForNetworkIdle(page: Page, runId: string): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: readinessTiming.networkIdleTimeout })
  } catch (error) {
    if (page.isClosed()) throw error
    app.log.debug(
      { runId, timeout: readinessTiming.networkIdleTimeout },
      'Network did not become idle before the soft timeout',
    )
  }
}

async function waitForVisibleImages(page: Page): Promise<void> {
  await page.waitForFunction(() =>
    Array.from(document.images)
      .filter((image) => {
        const rect = image.getBoundingClientRect()
        return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
      })
      .every((image) => image.complete),
  )

  await page.evaluate(async () => {
    const visibleLoadedImages = Array.from(document.images).filter((image) => {
      const rect = image.getBoundingClientRect()
      const isVisible =
        rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
      return isVisible && image.complete && image.naturalWidth > 0
    })
    await Promise.allSettled(visibleLoadedImages.map((image) => image.decode()))
  })
}

async function waitForDomStability(page: Page, runId: string): Promise<void> {
  const startedAt = Date.now()
  let stableSince = startedAt
  let previousContent = await page.content()

  while (Date.now() - startedAt < readinessTiming.domStabilityTimeout) {
    await page.waitForTimeout(readinessTiming.domPollInterval)
    const currentContent = await page.content()
    if (currentContent !== previousContent) {
      previousContent = currentContent
      stableSince = Date.now()
      continue
    }
    if (Date.now() - stableSince >= readinessTiming.domQuietTime) return
  }

  app.log.debug(
    { runId, timeout: readinessTiming.domStabilityTimeout },
    'DOM did not become stable before the soft timeout',
  )
}

async function waitForPageReady(page: Page, readySelector: string, runId: string): Promise<void> {
  if (readySelector) {
    await page.locator(readySelector).waitFor({ state: 'visible' })
  }
  await waitForNetworkIdle(page, runId)
  await page.waitForFunction(() => document.fonts.status === 'loaded')
  await waitForVisibleImages(page)
  await waitForDomStability(page, runId)
  await page.waitForTimeout(readinessTiming.finalSettleTime)
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
    observePageFailures(page, runId)

    await updateRun(runId, { status: 'navigating' })
    await page.goto(launching.request.url, { waitUntil: 'domcontentloaded' })

    await updateRun(runId, { status: 'waiting' })
    await waitForPageReady(page, launching.request.readySelector, runId)
    if (launching.request.captureDelayMs > 0) {
      app.log.debug(
        { runId, delayMs: launching.request.captureDelayMs },
        'Applying additional capture delay',
      )
      await page.waitForTimeout(launching.request.captureDelayMs)
      await waitForPageReady(page, launching.request.readySelector, runId)
    }

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
await normalizeInterruptedBatches()
await normalizeInterruptedAgentRuns()
await app.register(fastifyStatic, { root: runsDir, prefix: '/outputs/' })
await registerFontCheck(app)
await registerAgent(app)
await registerTestConfigurationRoutes(app)

app.get<{ Reply: HealthResponse }>('/api/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
}))

app.post<{ Body: unknown; Reply: CreateBatchResponse | ApiErrorResponse }>(
  '/api/batches',
  async (request, reply) => {
    const parsed = parseCreateBatchRequest(request.body)
    if (!parsed) return reply.code(400).send({ error: 'Invalid screenshot batch request' })

    const createdAt = new Date()
    const now = createdAt.toISOString()
    const batchId = createArchiveId(createdAt)
    const devices = parsed.devices.map<ScreenshotDeviceRun>((device) => ({
      ...device,
      runId: null,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      screenshotPath: null,
      screenshotUrl: null,
      error: null,
    }))
    const batch: BatchManifest = {
      kind: 'viewport',
      batchId,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      url: parsed.url,
      note: parsed.note,
      captureDelayMs: parsed.captureDelayMs,
      status: 'queued',
      durationMs: null,
      deviceCount: devices.length,
      successCount: 0,
      failedCount: 0,
      devices,
    }
    const batchDirectory = resolve(runsDir, batchId)
    await mkdir(batchDirectory, { recursive: true })
    batches.set(batchId, batch)
    await persistBatch(batch)
    const registrationTimer = setTimeout(() => {
      void failUnregisteredDevices(batchId).catch((error: unknown) => {
        app.log.error({ err: error, batchId }, 'Failed to finalize unregistered screenshot devices')
      })
    }, runRegistrationTimeout)
    registrationTimer.unref()
    return reply.code(201).send({ batch })
  },
)

app.get<{ Reply: ListBatchesResponse }>('/api/batches', async () => ({
  batches: (await listBatches()).map(toBatchSummary),
}))

app.get<{
  Params: { batchId: string }
  Reply: BatchManifest | ApiErrorResponse
}>('/api/batches/:batchId', async (request, reply) => {
  const batch = await readBatch(request.params.batchId)
  if (!batch) return reply.code(404).send({ error: 'Screenshot batch not found' })
  return reply.send(batch)
})

app.patch<{
  Params: { batchId: string }
  Body: unknown
  Reply: BatchManifest | ApiErrorResponse
}>('/api/batches/:batchId', async (request, reply) => {
  const body = request.body as Partial<UpdateRunNoteRequest> | null
  if (typeof body?.note !== 'string' || body.note.trim().length > batchNoteMaxLength) {
    return reply.code(400).send({ error: 'Invalid task title' })
  }
  const note = body.note.trim()
  let updated: BatchManifest | null = null
  await enqueueBatchUpdate(request.params.batchId, async () => {
    const batch = await readBatch(request.params.batchId)
    if (!batch) return
    updated = {
      ...batch,
      note,
      updatedAt: new Date().toISOString(),
    }
    batches.set(batch.batchId, updated)
    await persistBatch(updated)
  })
  if (!updated) return reply.code(404).send({ error: 'Screenshot batch not found' })
  return reply.send(updated)
})

app.post<{
  Params: { batchId: string }
  Body: unknown
  Reply: RerunBatchResponse | ApiErrorResponse
}>('/api/batches/:batchId/rerun', async (request, reply) => {
  const body = request.body as Partial<RerunBatchRequest> | null
  const scope = body?.scope
  if (scope !== 'all' && scope !== 'failed') {
    return reply.code(400).send({ error: 'Invalid rerun scope' })
  }

  const { batchId } = request.params
  await batchUpdateQueues.get(batchId)
  await batchWriteQueues.get(batchId)
  const batch = await readBatch(batchId)
  if (!batch) return reply.code(404).send({ error: 'Screenshot batch not found' })
  if (!isTerminalBatchStatus(batch.status)) {
    return reply.code(409).send({ error: '只能重跑已结束的截图批次' })
  }

  const selectedDevices =
    scope === 'failed'
      ? batch.devices.filter((device) => device.status === 'failed')
      : batch.devices
  if (selectedDevices.length === 0) {
    return reply.code(409).send({ error: '当前批次没有失败设备' })
  }

  const selectionIds = selectedDevices.map((device) => device.selectionId)
  const selectedIdSet = new Set(selectionIds)
  const rerunAt = new Date().toISOString()
  for (const device of selectedDevices) {
    if (device.runId) {
      runs.delete(device.runId)
      subscribers.delete(device.runId)
    }
    await rm(resolve(runsDir, batchId, `${device.presetId}.png`), { force: true })
  }
  const devices = batch.devices.map<ScreenshotDeviceRun>((device) =>
    selectedIdSet.has(device.selectionId)
      ? {
          ...device,
          runId: null,
          status: 'queued',
          createdAt: rerunAt,
          updatedAt: rerunAt,
          completedAt: null,
          screenshotPath: null,
          screenshotUrl: null,
          error: null,
        }
      : device,
  )
  const updated = aggregateBatch({ ...batch, devices, completedAt: null }, rerunAt)
  batches.set(batchId, updated)
  await persistBatch(updated)

  const registrationTimer = setTimeout(() => {
    void failUnregisteredDevices(batchId).catch((error: unknown) => {
      app.log.error({ err: error, batchId }, 'Failed to finalize rerun screenshot devices')
    })
  }, runRegistrationTimeout)
  registrationTimer.unref()

  return reply.send({ batch: updated, selectionIds })
})

app.delete<{ Params: { batchId: string } }>('/api/batches/:batchId', async (request, reply) => {
  const { batchId } = request.params
  const batch = await readBatch(batchId)
  if (!batch) return reply.code(404).send({ error: 'Screenshot batch not found' })
  if (!isTerminalBatchStatus(batch.status)) {
    return reply.code(409).send({ error: 'Running screenshot batches cannot be deleted' })
  }
  await batchUpdateQueues.get(batchId)
  await batchWriteQueues.get(batchId)
  for (const device of batch.devices) {
    if (device.runId) {
      runs.delete(device.runId)
      subscribers.delete(device.runId)
    }
  }
  batches.delete(batchId)
  await rm(resolve(runsDir, batchId), { recursive: true })
  return reply.code(204).send()
})

app.post<{ Body: unknown; Reply: CreateRunResponse | ApiErrorResponse }>(
  '/api/runs',
  async (request, reply) => {
    const parsed = parseCreateRunRequest(request.body)
    if (!parsed) return reply.code(400).send({ error: 'Invalid screenshot request' })
    const batch = await readBatch(parsed.batchId)
    if (!batch) return reply.code(400).send({ error: 'Screenshot batch does not exist' })
    const device = batch.devices.find((item) => item.selectionId === parsed.selectionId)
    if (!device || !requestMatchesDevice(parsed, batch, device)) {
      return reply.code(400).send({ error: 'Screenshot request does not match the batch manifest' })
    }
    if (device.runId && device.status !== 'failed') {
      return reply.code(409).send({ error: 'Screenshot device is already running or completed' })
    }
    const expectedRunCount = batch.devices.filter(
      (item) => item.status === 'queued' && item.runId === null,
    ).length

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
    await updateBatchForRun(run)
    viewportBatchScheduler.enqueue(parsed.batchId, expectedRunCount, async () => {
      try {
        await executeRun(runId)
      } catch (error: unknown) {
        app.log.error({ err: error, runId }, 'Unexpected screenshot task failure')
        throw error
      }
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
