import type {
  AgentPageState,
  AgentRunStatus,
  AgentSnapshotMeta,
  AgentStepInfo,
  AgentWaitResult,
  DeviceAgentRun,
  DeviceAgentStep,
  ScreenshotDevicePresetSnapshot,
} from '@viewport-lab/shared'
import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'

import type { AgentCliBridge, CliResult } from './cli-bridge.js'
import { sanitizeSessionId } from './cli-bridge.js'
import type { AgentGatewayConfig } from './config.js'
import type { ActionResultReport, NextActionResult } from './llm-client.js'
import { createDeviceLlmClient } from './llm-client.js'
import { preparePageObservation, waitForPageReady } from './page-readiness.js'
import { sanitizeDeviceDir } from './recorder.js'
import type { RecordedStep } from './test-script-generator.js'
import { generateSpec } from './test-script-generator.js'

const SNAPSHOT_MODEL_LIMIT = 40_000
const ACTION_OUTPUT_MODEL_LIMIT = 4_000

function snapshotFilePath(dir: string, stepIndex: number): string {
  return `${dir}/${String(stepIndex).padStart(2, '0')}.txt`
}

export interface DeviceAgentArtifacts {
  screenshotsDir: string
  snapshotsDir: string
  specDir: string
  finalScreenshotPath: string
}

export interface SharedDeviceAgentDeps {
  devices: ScreenshotDevicePresetSnapshot[]
  captureDeviceIds?: ReadonlySet<string>
  leaderDeviceId?: string
  existingDeviceRuns?: DeviceAgentRun[]
  artifacts: Map<string, DeviceAgentArtifacts>
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
 * Runs the LLM-driven flow once in the leader browser, then resizes that same
 * browser to capture the requested logical viewports. Generated specs remain
 * an archive of the leader flow and are never used to produce follower images.
 */
export async function runSharedDeviceAgent(deps: SharedDeviceAgentDeps): Promise<DeviceAgentRun[]> {
  const leader = findLeader(deps.devices, deps.leaderDeviceId)
  if (!leader) throw new Error('共享 Agent 至少需要一个设备')

  const captureIds =
    deps.captureDeviceIds ?? new Set(deps.devices.map((device) => device.selectionId))
  const existingById = new Map(
    (deps.existingDeviceRuns ?? []).map((deviceRun) => [deviceRun.deviceId, deviceRun]),
  )
  const runs = new Map<string, DeviceAgentRun>()
  for (const device of deps.devices) {
    const existing = existingById.get(device.selectionId)
    const shouldReset = captureIds.has(device.selectionId)
    runs.set(device.selectionId, createDeviceRun(device, shouldReset ? undefined : existing))
  }

  const leaderArtifacts = deps.artifacts.get(leader.selectionId)
  if (!leaderArtifacts) throw new Error(`主设备 ${leader.selectionId} 缺少运行目录`)
  const leaderRuntime = createLeaderRuntime(
    deps,
    leader,
    leaderArtifacts,
    runs.get(leader.selectionId)!,
  )
  runs.set(leader.selectionId, leaderRuntime.deviceRun)
  let leaderSucceeded = false
  let leaderSummary: AgentStepInfo | null = null
  let leaderError: string | null = null

  try {
    leaderError = await launchLeader(deps, leaderRuntime)
    if (!leaderError) {
      const initialSnapshot = leaderRuntime.deviceRun.steps[0]?.snapshot ?? '(snapshot unavailable)'
      const createLlmClient = deps.createLlmClient ?? createDeviceLlmClient
      const llm = createLlmClient(deps.gatewayConfig, leader, deps.url, initialSnapshot, deps.task)
      try {
        for (let turn = 1; turn <= deps.maxTurns; turn++) {
          setStatus(deps, leaderRuntime.deviceRun, 'awaiting_gateway', null)
          const next = await nextAction(llm)
          if ('error' in next) {
            leaderError = next.error
            break
          }
          if (next.value.done) {
            leaderSummary = next.value.summary
            leaderSucceeded = true
            break
          }
          if (!next.value.command) {
            leaderError = 'LLM 未返回命令且未声明完成'
            break
          }
          const report = await executeLeaderAction(deps, leaderRuntime, turn, next.value)
          llm.reportResult(report)
        }
      } finally {
        llm.close()
      }
      if (!leaderSucceeded && !leaderError) {
        leaderError = `Agent 达到最大轮数 ${deps.maxTurns}，未收到完成信号`
      }
    }

    if (leaderError) {
      failLeaderAndTargets(deps, leaderRuntime, runs, captureIds, leaderError)
    } else {
      leaderRuntime.deviceRun.summary = leaderSummary
      await writeLeaderSpec(deps, leaderRuntime)
      setStatus(deps, leaderRuntime.deviceRun, 'completed', null)
      for (const device of deps.devices) {
        if (!captureIds.has(device.selectionId)) continue
        const deviceRun = runs.get(device.selectionId)!
        await captureViewport(deps, leaderRuntime, device, deviceRun)
      }
    }
  } finally {
    try {
      await deps.cliBridge.close(leaderRuntime.session)
    } catch {
      // Session cleanup is best-effort.
    }
  }

  return deps.devices.map((device) => runs.get(device.selectionId)!)
}

function findLeader(
  devices: ScreenshotDevicePresetSnapshot[],
  leaderDeviceId?: string,
): ScreenshotDevicePresetSnapshot | null {
  return devices.find((device) => device.selectionId === leaderDeviceId) ?? devices[0] ?? null
}

function createDeviceRun(
  device: ScreenshotDevicePresetSnapshot,
  existing?: DeviceAgentRun,
): DeviceAgentRun {
  if (existing) return { ...existing, steps: [...existing.steps] }
  return {
    deviceId: device.selectionId,
    platformId: device.platformId,
    presetId: device.presetId,
    presetName: device.presetName,
    cliDeviceName: '',
    status: 'queued',
    steps: [],
    finalScreenshotPath: null,
    finalScreenshotUrl: null,
    testScriptUrl: null,
    error: null,
    summary: null,
    durationMs: null,
  }
}

function createLeaderRuntime(
  deps: SharedDeviceAgentDeps,
  device: ScreenshotDevicePresetSnapshot,
  artifacts: DeviceAgentArtifacts,
  deviceRun: DeviceAgentRun,
): DeviceRuntime {
  return {
    device,
    artifacts,
    deviceRun: {
      ...deviceRun,
      cliDeviceName: '',
      status: 'queued',
      steps: [],
      testScriptUrl: null,
      summary: null,
      error: null,
      durationMs: null,
    },
    session: sanitizeSessionId(`agent-${deps.runId.slice(-8)}-${device.selectionId}`),
    safeDeviceId: sanitizeDeviceDir(device.selectionId),
    recordedSteps: [],
    startedAt: Date.now(),
    lastSnapshot: null,
  }
}

async function launchLeader(
  deps: SharedDeviceAgentDeps,
  runtime: DeviceRuntime,
): Promise<string | null> {
  const { device, session } = runtime
  setStatus(deps, runtime.deviceRun, 'launching', null)
  try {
    const openResult = await deps.cliBridge.open(session, viewportOptions(device))
    if (!openResult.ok) throw new Error(resultError(openResult, 'Playwright CLI 启动失败'))
    const gotoResult = await deps.cliBridge.execute(session, 'goto', [deps.url])
    if (!gotoResult.ok) throw new Error(resultError(gotoResult, '打开页面失败'))

    const before = await tryPrepareObservation(deps.cliBridge, session)
    const observation = await observeLeaderPage(deps, runtime, 0, 'goto', before)
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
      startedAt: new Date(runtime.startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - runtime.startedAt,
    })
    return message
  }
}

async function nextAction(
  llm: ReturnType<typeof createDeviceLlmClient>,
): Promise<{ value: NextActionResult } | { error: string }> {
  try {
    return { value: await llm.nextAction() }
  } catch (error) {
    return { error: errorMessage(error) }
  }
}

async function executeLeaderAction(
  deps: SharedDeviceAgentDeps,
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
  const observation = await observeLeaderPage(deps, runtime, stepIndex, command, before)
  if (result.ok)
    runtime.recordedSteps.push({ command, args: [...next.args], purpose: next.purpose, locator })
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

async function captureViewport(
  deps: SharedDeviceAgentDeps,
  leaderRuntime: DeviceRuntime,
  device: ScreenshotDevicePresetSnapshot,
  deviceRun: DeviceAgentRun,
): Promise<void> {
  const artifacts = deps.artifacts.get(device.selectionId)
  if (!artifacts) {
    setStatus(deps, deviceRun, 'failed', '设备截图目录不存在')
    return
  }
  const startedAt = Date.now()
  setStatus(deps, deviceRun, 'capturing', null)
  try {
    const resizeResult = await deps.cliBridge.configureViewport(
      leaderRuntime.session,
      viewportOptions(device),
    )
    if (!resizeResult.ok) throw new Error(resultError(resizeResult, '切换逻辑视口失败'))
    const before = await tryPrepareObservation(deps.cliBridge, leaderRuntime.session)
    await safeWaitForPageReady(deps.cliBridge, leaderRuntime.session, 'resize', before)
    if ((deps.screenshotDelayMs ?? 0) > 0) await delay(deps.screenshotDelayMs ?? 0)
    const shot = await deps.cliBridge.screenshot(
      leaderRuntime.session,
      artifacts.finalScreenshotPath,
      viewportOptions(device),
    )
    if (!shot.ok) throw new Error(resultError(shot, '保存最终截图失败'))
    deviceRun.finalScreenshotPath = `data/runs/${deps.runId}/${sanitizeDeviceDir(device.selectionId)}.png`
    deviceRun.finalScreenshotUrl = `/outputs/${deps.runId}/${sanitizeDeviceDir(device.selectionId)}.png`
    deviceRun.durationMs = Date.now() - startedAt
    setStatus(deps, deviceRun, 'completed', null)
  } catch (error) {
    deviceRun.finalScreenshotPath = null
    deviceRun.finalScreenshotUrl = null
    deviceRun.durationMs = Date.now() - startedAt
    setStatus(deps, deviceRun, 'failed', errorMessage(error))
  }
}

function failLeaderAndTargets(
  deps: SharedDeviceAgentDeps,
  leaderRuntime: DeviceRuntime,
  runs: Map<string, DeviceAgentRun>,
  captureIds: ReadonlySet<string>,
  error: string,
): void {
  leaderRuntime.deviceRun.durationMs = Date.now() - leaderRuntime.startedAt
  setStatus(deps, leaderRuntime.deviceRun, 'failed', error)
  for (const device of deps.devices) {
    if (
      device.selectionId === leaderRuntime.device.selectionId ||
      !captureIds.has(device.selectionId)
    )
      continue
    const deviceRun = runs.get(device.selectionId)!
    deviceRun.durationMs = 0
    setStatus(deps, deviceRun, 'failed', '主设备 Agent 未完成，未生成视口截图')
  }
}

async function writeLeaderSpec(deps: SharedDeviceAgentDeps, runtime: DeviceRuntime): Promise<void> {
  try {
    const content = generateSpec(runtime.device, deps.url, deps.task, runtime.recordedSteps)
    await writeFile(`${runtime.artifacts.specDir}/agent.spec.ts`, content, 'utf8')
    runtime.deviceRun.testScriptUrl = `/outputs/${deps.runId}/agent/${runtime.safeDeviceId}/agent.spec.ts`
  } catch (error) {
    runtime.deviceRun.testScriptUrl = null
    runtime.deviceRun.error = errorMessage(error)
  }
}

async function observeLeaderPage(
  deps: SharedDeviceAgentDeps,
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
    const shot = await deps.cliBridge.screenshot(
      runtime.session,
      shotPath,
      viewportOptions(runtime.device),
    )
    if (shot.ok)
      screenshotUrl = `/outputs/${deps.runId}/agent/${runtime.safeDeviceId}/steps/${String(stepIndex).padStart(2, '0')}.png`
  } catch {
    // Keep the step even when its screenshot cannot be saved.
  }
  return { wait: readiness.wait, page: readiness.page, snapshot, snapshotMeta, screenshotUrl }
}

function appendStep(
  deps: SharedDeviceAgentDeps,
  runtime: DeviceRuntime,
  step: DeviceAgentStep,
): void {
  runtime.deviceRun.steps.push(step)
  deps.onDeviceStep(runtime.device.selectionId, step)
}

function setStatus(
  deps: SharedDeviceAgentDeps,
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
  return !['snapshot', 'find', 'goto', 'go-back', 'go-forward', 'reload', 'press', 'eval'].includes(
    command,
  )
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
