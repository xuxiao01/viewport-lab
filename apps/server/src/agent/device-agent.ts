import type {
  AgentPageState,
  AgentRunStatus,
  AgentSnapshotMeta,
  AgentWaitResult,
  AgentViewportMetrics,
  DeviceAgentRun,
  DeviceAgentStep,
  ScreenshotDevicePresetSnapshot,
} from '@viewport-lab/shared'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'

import type { AgentCliBridge, CliResult } from './cli-bridge.js'
import { sanitizeSessionId } from './cli-bridge.js'
import type { AgentGatewayConfig } from './config.js'
import type { ActionResultReport, DeviceLlmClient, NextActionResult } from './llm-client.js'
import { createDeviceLlmClient } from './llm-client.js'
import { preparePageObservation, waitForPageReady } from './page-readiness.js'
import { sanitizeDeviceDir } from './recorder.js'
import type { RecordedStep } from './test-script-generator.js'
import { generateSpec } from './test-script-generator.js'

const SNAPSHOT_MODEL_LIMIT = 40_000
const ACTION_OUTPUT_MODEL_LIMIT = 4_000
const GATEWAY_RETRY_LIMIT = 3
const GATEWAY_RETRY_BASE_DELAY_MS = 1_000

function snapshotFilePath(dir: string, stepIndex: number): string {
  return `${dir}/${String(stepIndex).padStart(2, '0')}.txt`
}

export interface DeviceAgentArtifacts {
  screenshotsDir: string
  snapshotsDir: string
  specDir: string
  finalScreenshotPath: string
}

export interface DeviceAgentDeps {
  device: ScreenshotDevicePresetSnapshot
  artifacts: DeviceAgentArtifacts
  url: string
  task: string
  maxTurns: number
  runId: string
  gatewayConfig: AgentGatewayConfig | null
  cliBridge: AgentCliBridge
  onDeviceStatus: (deviceId: string, status: AgentRunStatus, error: string | null) => void
  onDeviceStep: (deviceId: string, step: DeviceAgentStep) => void
  createLlmClient?: typeof createDeviceLlmClient
  screenshotDelayMs?: number
  gatewayRetryDelayMs?: number
  isCancelled?: () => boolean
}

interface DeviceRuntime {
  device: ScreenshotDevicePresetSnapshot
  artifacts: DeviceAgentArtifacts
  deviceRun: DeviceAgentRun
  session: string
  safeDeviceId: string
  recordedSteps: RecordedStep[]
  startedAt: number
  lastSnapshot: { sha256: string; stepIndex: number; snapshotRef: string } | null
}

interface PageObservation {
  wait: AgentWaitResult
  page: AgentPageState
  snapshot: string | null
  snapshotMeta: AgentSnapshotMeta | null
  screenshotUrl: string | null
}

/**
 * Runs one complete LLM-driven Agent in one device-specific BrowserContext.
 * No page, model conversation, locator or browser state is shared with another device.
 */
export async function runDeviceAgent(deps: DeviceAgentDeps): Promise<DeviceAgentRun> {
  const runtime = createRuntime(deps)
  let failure: string | null = null
  let completedByModel = false

  try {
    if (deps.isCancelled?.()) {
      setStatus(deps, runtime.deviceRun, 'cancelled', '任务已取消')
      return runtime.deviceRun
    }
    failure = await launchDevice(deps, runtime)
    if (!failure) {
      const initialSnapshot = runtime.deviceRun.steps[0]?.snapshot ?? '(snapshot unavailable)'
      const createLlmClient = deps.createLlmClient ?? createDeviceLlmClient
      const llm = createLlmClient(
        deps.gatewayConfig,
        deps.device,
        deps.url,
        initialSnapshot,
        deps.task,
      )
      try {
        for (let turn = 1; turn <= deps.maxTurns; turn++) {
          if (deps.isCancelled?.()) break
          setStatus(deps, runtime.deviceRun, 'awaiting_gateway', null)
          const next = await nextActionWithRetry(deps, llm)
          if (deps.isCancelled?.()) break
          if ('error' in next) {
            failure = next.error
            break
          }
          if (next.value.done) {
            runtime.deviceRun.summary = next.value.summary
            completedByModel = true
            break
          }
          if (!next.value.command) {
            failure = 'LLM 未返回命令且未声明完成'
            break
          }
          const report = await executeDeviceAction(deps, runtime, turn, next.value)
          llm.reportResult(report)
        }
      } finally {
        llm.close()
      }
      if (!completedByModel && !failure && !deps.isCancelled?.()) {
        failure = `Agent 达到最大轮数 ${deps.maxTurns}，未收到完成信号`
      }
    }

    if (!deps.isCancelled?.()) {
      await writeDeviceSpec(deps, runtime)
      const captureError = await captureFinalScreenshot(deps, runtime)
      if (!failure && captureError) failure = captureError
    }
  } catch (error) {
    failure = errorMessage(error)
    if (!deps.isCancelled?.() && !runtime.deviceRun.finalScreenshotUrl) {
      await captureFinalScreenshot(deps, runtime).catch(() => undefined)
    }
  } finally {
    runtime.deviceRun.durationMs = Date.now() - runtime.startedAt
    try {
      await deps.cliBridge.close(runtime.session)
    } catch {
      // A device session is isolated; cleanup failure must not affect other devices.
    }
  }

  if (deps.isCancelled?.()) setStatus(deps, runtime.deviceRun, 'cancelled', '任务已取消')
  else if (failure) setStatus(deps, runtime.deviceRun, 'failed', failure)
  else setStatus(deps, runtime.deviceRun, 'completed', null)
  return runtime.deviceRun
}

function createRuntime(deps: DeviceAgentDeps): DeviceRuntime {
  const { device } = deps
  return {
    device,
    artifacts: deps.artifacts,
    deviceRun: {
      deviceId: device.selectionId,
      platformId: device.platformId,
      presetId: device.presetId,
      presetName: device.presetName,
      cliDeviceName: '',
      status: 'queued',
      steps: [],
      replaySteps: [],
      viewportMetrics: null,
      screenshotPixelSize: null,
      finalScreenshotPath: null,
      finalScreenshotUrl: null,
      testScriptUrl: null,
      error: null,
      summary: null,
      durationMs: null,
    },
    session: getDeviceAgentSessionId(deps.runId, device.selectionId),
    safeDeviceId: sanitizeDeviceDir(device.selectionId),
    recordedSteps: [],
    startedAt: Date.now(),
    lastSnapshot: null,
  }
}

export function getDeviceAgentSessionId(runId: string, deviceId: string): string {
  return sanitizeSessionId(`agent-${runId.slice(-8)}-${deviceId}`)
}

async function launchDevice(deps: DeviceAgentDeps, runtime: DeviceRuntime): Promise<string | null> {
  const { device, session } = runtime
  setStatus(deps, runtime.deviceRun, 'launching', null)
  try {
    const openResult = await deps.cliBridge.open(session, viewportOptions(device))
    if (!openResult.ok) throw new Error(resultError(openResult, 'Playwright CLI 启动失败'))
    const gotoResult = await deps.cliBridge.execute(session, 'goto', [deps.url])
    if (!gotoResult.ok) throw new Error(resultError(gotoResult, '打开页面失败'))

    const before = await tryPrepareObservation(deps.cliBridge, session)
    const observation = await observeDevicePage(deps, runtime, 0, 'goto', before)
    appendStep(deps, runtime, {
      stepIndex: 0,
      command: 'goto',
      args: [deps.url],
      purpose: '打开页面',
      status: 'success',
      info: null,
      output: null,
      error: null,
      wait: observation.wait,
      page: observation.page,
      snapshot: observation.snapshot,
      snapshotMeta: observation.snapshotMeta,
      screenshotUrl: observation.screenshotUrl,
      locator: null,
      replayLocator: null,
      startedAt: new Date(runtime.startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - runtime.startedAt,
    })
    setStatus(deps, runtime.deviceRun, 'running', null)
    return null
  } catch (error) {
    const message = errorMessage(error)
    appendStep(deps, runtime, {
      stepIndex: 0,
      command: 'goto',
      args: [deps.url],
      purpose: '打开页面',
      status: 'failed',
      info: null,
      output: message,
      error: message,
      wait: null,
      page: null,
      snapshot: null,
      snapshotMeta: null,
      screenshotUrl: null,
      locator: null,
      replayLocator: null,
      startedAt: new Date(runtime.startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - runtime.startedAt,
    })
    return message
  }
}

async function nextActionWithRetry(
  deps: DeviceAgentDeps,
  llm: DeviceLlmClient,
): Promise<{ value: NextActionResult } | { error: string }> {
  let lastError = ''
  for (let attempt = 1; attempt <= GATEWAY_RETRY_LIMIT; attempt++) {
    if (deps.isCancelled?.()) return { error: '任务已取消' }
    try {
      return { value: await llm.nextAction() }
    } catch (error) {
      lastError = errorMessage(error)
      if (!isRetryableGatewayError(lastError) || attempt === GATEWAY_RETRY_LIMIT) {
        return { error: lastError }
      }
      const baseDelay = deps.gatewayRetryDelayMs ?? GATEWAY_RETRY_BASE_DELAY_MS
      const jitter = baseDelay > 0 ? Math.floor(Math.random() * Math.max(1, baseDelay / 4)) : 0
      await delay(baseDelay * 2 ** (attempt - 1) + jitter)
    }
  }
  return { error: lastError || 'AI 网关调用失败' }
}

function isRetryableGatewayError(message: string): boolean {
  return /(?:\b429\b|too many requests|rate.?limit|\b5\d\d\b|timeout|timed out|network|ECONNRESET|ECONNREFUSED)/i.test(
    message,
  )
}

async function executeDeviceAction(
  deps: DeviceAgentDeps,
  runtime: DeviceRuntime,
  stepIndex: number,
  next: NextActionResult,
): Promise<ActionResultReport> {
  const command = next.command!
  const startedAt = new Date().toISOString()
  setStatus(deps, runtime.deviceRun, 'executing', null)
  let result: CliResult = { ok: false, output: '', error: '工具调用尚未执行' }
  let locator: string | null = null
  let before: Awaited<ReturnType<typeof tryPrepareObservation>> = null
  try {
    before = await tryPrepareObservation(deps.cliBridge, runtime.session)
    const ref = next.args.find((arg) => /^[fe]\d/.test(arg)) ?? null
    if (ref && supportsLocator(command)) {
      const locatorResult = await deps.cliBridge.generateLocator(runtime.session, ref)
      if (locatorResult.ok && locatorResult.output) locator = locatorResult.output
    }
    result =
      command === 'snapshot'
        ? { ok: true, output: 'Snapshot captured after page readiness.', error: null }
        : await deps.cliBridge.execute(runtime.session, command, next.args)
  } catch (error) {
    result = { ok: false, output: '', error: errorMessage(error) }
  }

  setStatus(deps, runtime.deviceRun, 'capturing', null)
  const observation = await observeDevicePage(deps, runtime, stepIndex, command, before)
  if (result.ok) {
    runtime.recordedSteps.push({
      stepIndex,
      command,
      args: [...next.args],
      purpose: next.purpose,
      locator,
      replayLocator: null,
    })
  }
  const completedAt = new Date().toISOString()
  const output = result.ok
    ? limitOutput(result.output)
    : limitOutput(resultError(result, '工具调用执行失败'))
  const step: DeviceAgentStep = {
    stepIndex,
    command,
    args: [...next.args],
    purpose: next.purpose,
    status: result.ok ? 'success' : 'failed',
    info: next.info,
    output,
    error: result.error,
    wait: observation.wait,
    page: observation.page,
    snapshot: observation.snapshot,
    snapshotMeta: observation.snapshotMeta,
    screenshotUrl: observation.screenshotUrl,
    locator,
    replayLocator: null,
    startedAt,
    completedAt,
    durationMs: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
  }
  appendStep(deps, runtime, step)
  return {
    ok: result.ok,
    error: result.error,
    command,
    output: limitOutput(result.output),
    wait: observation.wait,
    page: observation.page,
    snapshot: observation.snapshot,
    snapshotMeta: observation.snapshotMeta,
    screenshotUrl: observation.screenshotUrl,
  }
}

async function writeDeviceSpec(deps: DeviceAgentDeps, runtime: DeviceRuntime): Promise<void> {
  try {
    const content = generateSpec(runtime.device, deps.url, deps.task, runtime.recordedSteps)
    await writeFile(`${runtime.artifacts.specDir}/agent.spec.ts`, content, 'utf8')
    runtime.deviceRun.testScriptUrl = `/outputs/${deps.runId}/agent/${runtime.safeDeviceId}/agent.spec.ts`
  } catch (error) {
    runtime.deviceRun.testScriptUrl = null
    runtime.deviceRun.error = errorMessage(error)
  }
}

async function captureFinalScreenshot(
  deps: DeviceAgentDeps,
  runtime: DeviceRuntime,
): Promise<string | null> {
  setStatus(deps, runtime.deviceRun, 'capturing', runtime.deviceRun.error)
  try {
    const before = await tryPrepareObservation(deps.cliBridge, runtime.session)
    await safeWaitForPageReady(deps.cliBridge, runtime.session, 'capture', before)
    if ((deps.screenshotDelayMs ?? 0) > 0) await delay(deps.screenshotDelayMs ?? 0)

    runtime.deviceRun.viewportMetrics = await collectViewportMetrics(
      deps.cliBridge,
      runtime.session,
    )
    const shot = await deps.cliBridge.screenshot(
      runtime.session,
      runtime.artifacts.finalScreenshotPath,
    )
    if (!shot.ok) throw new Error(resultError(shot, '保存最终截图失败'))
    runtime.deviceRun.screenshotPixelSize = await readPngSize(runtime.artifacts.finalScreenshotPath)
    runtime.deviceRun.finalScreenshotPath = `data/runs/${deps.runId}/${runtime.safeDeviceId}.png`
    runtime.deviceRun.finalScreenshotUrl = `/outputs/${deps.runId}/${runtime.safeDeviceId}.png`
    return null
  } catch (error) {
    return errorMessage(error)
  }
}

async function collectViewportMetrics(
  bridge: AgentCliBridge,
  session: string,
): Promise<AgentViewportMetrics | null> {
  const result = await bridge.runCode(
    session,
    String.raw`async (page) => JSON.stringify(await page.evaluate(() => {
      const viewportMeta = document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? ''
      const widthMatch = viewportMeta.match(/(?:^|,)\s*width\s*=\s*([0-9.]+)/i)
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        screenWidth: window.screen.width,
        screenHeight: window.screen.height,
        devicePixelRatio: window.devicePixelRatio,
        maxTouchPoints: navigator.maxTouchPoints,
        pointerCoarse: matchMedia('(pointer: coarse)').matches,
        visualViewportWidth: window.visualViewport?.width ?? null,
        visualViewportHeight: window.visualViewport?.height ?? null,
        visualViewportScale: window.visualViewport?.scale ?? null,
        viewportMetaWidth: widthMatch ? Number(widthMatch[1]) : null,
      }
    }))`,
  )
  if (!result.ok) return null
  try {
    let parsed: unknown = JSON.parse(result.output)
    if (typeof parsed === 'string') parsed = JSON.parse(parsed)
    return parsed as AgentViewportMetrics
  } catch {
    return null
  }
}

async function readPngSize(path: string): Promise<{ width: number; height: number } | null> {
  try {
    const buffer = await readFile(path)
    if (
      buffer.length < 24 ||
      buffer.toString('ascii', 1, 4) !== 'PNG' ||
      buffer.toString('ascii', 12, 16) !== 'IHDR'
    ) {
      return null
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  } catch {
    return null
  }
}

async function observeDevicePage(
  deps: DeviceAgentDeps,
  runtime: DeviceRuntime,
  stepIndex: number,
  command: string,
  before: Awaited<ReturnType<typeof tryPrepareObservation>>,
): Promise<PageObservation> {
  const readiness = await safeWaitForPageReady(deps.cliBridge, runtime.session, command, before)
  let snapshotResult: CliResult
  try {
    snapshotResult = await deps.cliBridge.snapshot(runtime.session)
  } catch (error) {
    snapshotResult = { ok: false, output: '', error: errorMessage(error) }
  }
  let snapshot: string | null = null
  let snapshotMeta: AgentSnapshotMeta | null = null
  if (snapshotResult.ok) {
    const fullSnapshot = snapshotResult.output
    try {
      await writeFile(
        snapshotFilePath(runtime.artifacts.snapshotsDir, stepIndex),
        fullSnapshot,
        'utf8',
      )
    } catch {
      // Observation remains useful even if archival persistence fails.
    }
    const sha256 = createHash('sha256').update(fullSnapshot).digest('hex')
    const previous = runtime.lastSnapshot
    const changed = previous?.sha256 !== sha256
    const snapshotRef = changed
      ? `snapshot:${deps.runId}:${runtime.safeDeviceId}:${sha256}`
      : (previous?.snapshotRef ?? null)
    const returnedSnapshot = changed ? fullSnapshot.slice(0, SNAPSHOT_MODEL_LIMIT) : null
    snapshot = returnedSnapshot
    snapshotMeta = {
      snapshotRef,
      changed,
      truncated: fullSnapshot.length > SNAPSHOT_MODEL_LIMIT,
      originalChars: fullSnapshot.length,
      returnedChars: returnedSnapshot?.length ?? 0,
      sameAsStepIndex: changed ? null : (previous?.stepIndex ?? null),
      sha256,
    }
    if (changed && snapshotRef) runtime.lastSnapshot = { sha256, stepIndex, snapshotRef }
  }

  if ((deps.screenshotDelayMs ?? 0) > 0) await delay(deps.screenshotDelayMs ?? 0)
  const shotPath = `${runtime.artifacts.screenshotsDir}/${String(stepIndex).padStart(2, '0')}.png`
  let screenshotUrl: string | null = null
  try {
    const shot = await deps.cliBridge.screenshot(runtime.session, shotPath)
    if (shot.ok) {
      screenshotUrl = `/outputs/${deps.runId}/agent/${runtime.safeDeviceId}/steps/${String(stepIndex).padStart(2, '0')}.png`
    }
  } catch {
    // Keep the step even when its screenshot cannot be saved.
  }
  return { wait: readiness.wait, page: readiness.page, snapshot, snapshotMeta, screenshotUrl }
}

function appendStep(deps: DeviceAgentDeps, runtime: DeviceRuntime, step: DeviceAgentStep): void {
  runtime.deviceRun.steps.push(step)
  deps.onDeviceStep(runtime.device.selectionId, step)
}

function setStatus(
  deps: DeviceAgentDeps,
  deviceRun: DeviceAgentRun,
  status: AgentRunStatus,
  error: string | null,
): void {
  deviceRun.status = status
  deviceRun.error = error
  deps.onDeviceStatus(deviceRun.deviceId, status, error)
}

async function tryPrepareObservation(
  bridge: AgentCliBridge,
  session: string,
): Promise<Awaited<ReturnType<typeof preparePageObservation>> | null> {
  try {
    return await preparePageObservation(bridge, session)
  } catch {
    return null
  }
}

async function safeWaitForPageReady(
  bridge: AgentCliBridge,
  session: string,
  command: string,
  before: Awaited<ReturnType<typeof tryPrepareObservation>>,
): Promise<Awaited<ReturnType<typeof waitForPageReady>>> {
  try {
    return await waitForPageReady(bridge, session, command, before)
  } catch (error) {
    return {
      wait: {
        status: 'timed_out',
        reason: 'observer_error',
        elapsedMs: 0,
        signals: {
          navigation: { status: 'error', detail: errorMessage(error) },
          network: { status: 'error', detail: errorMessage(error) },
          dom: { status: 'error', detail: errorMessage(error) },
          fonts: { status: 'error', detail: errorMessage(error) },
          images: { status: 'error', detail: errorMessage(error) },
          paint: { status: 'error', detail: errorMessage(error) },
        },
      },
      page: { url: before?.url ?? '', title: before?.title ?? '' },
    }
  }
}

function supportsLocator(command: string): boolean {
  return !['snapshot', 'find', 'goto', 'go-back', 'go-forward', 'reload', 'eval'].includes(command)
}

function resultError(result: CliResult, fallback: string): string {
  return (result.error ?? result.output) || fallback
}

function limitOutput(value: string): string {
  if (value.length <= ACTION_OUTPUT_MODEL_LIMIT) return value
  const suffix = `\n...[工具输出已截断，共 ${value.length} 字符]`
  return `${value.slice(0, ACTION_OUTPUT_MODEL_LIMIT - suffix.length)}${suffix}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function viewportOptions(device: ScreenshotDevicePresetSnapshot): {
  width: number
  height: number
  deviceScaleFactor: number
  isMobile: boolean
  hasTouch: boolean
} {
  return {
    width: device.viewport.width,
    height: device.viewport.height,
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
