import type {
  AgentPageState,
  AgentRunStatus,
  AgentSnapshotMeta,
  AgentWaitResult,
  DeviceAgentRun,
  DeviceAgentStep,
  ScreenshotDevicePresetSnapshot,
} from '@viewport-lab/shared'
import { createHash } from 'node:crypto'
import { copyFile, writeFile } from 'node:fs/promises'

import type { AgentCliBridge, CliResult } from './cli-bridge.js'
import { sanitizeSessionId } from './cli-bridge.js'
import type { AgentGatewayConfig } from './config.js'
import { mapToDevice } from './device-mapper.js'
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
  artifacts: Map<string, DeviceAgentArtifacts>
  url: string
  task: string
  maxTurns: number
  runId: string
  gatewayConfig: AgentGatewayConfig | null
  cliBridge: AgentCliBridge
  onDeviceStatus: (deviceId: string, status: AgentRunStatus, error: string | null) => void
  onDeviceStep: (deviceId: string, step: DeviceAgentStep) => void
  onFollowerError: (params: {
    deviceId: string
    stepIndex: number
    command: string
    error: string
  }) => void | Promise<void>
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
  active: boolean
  lastScreenshotPath: string | null
  lastSnapshot: { sha256: string; stepIndex: number; snapshotRef: string } | null
}

interface ExecutedAction {
  runtime: DeviceRuntime
  report: ActionResultReport
  step: DeviceAgentStep
}

export async function runSharedDeviceAgent(deps: SharedDeviceAgentDeps): Promise<DeviceAgentRun[]> {
  const leader = deps.devices[0]
  if (!leader) throw new Error('共享 Agent 至少需要一个设备')

  const runtimes = deps.devices.map((device) => createRuntime(deps, device))
  await Promise.all(runtimes.map((runtime) => launchRuntime(deps, runtime)))

  const leaderRuntime = runtimes[0]!
  if (!leaderRuntime.active) {
    for (const runtime of runtimes.slice(1)) {
      if (!runtime.active) continue
      runtime.active = false
      runtime.deviceRun.status = 'cancelled'
      runtime.deviceRun.error = '主设备启动失败，未执行 Agent'
      deps.onDeviceStatus(runtime.device.selectionId, 'cancelled', runtime.deviceRun.error)
    }
    await Promise.all(runtimes.map((runtime) => finalizeRuntime(deps, runtime, null)))
    return runtimes.map((runtime) => runtime.deviceRun)
  }

  const initialSnapshot = leaderRuntime.deviceRun.steps[0]?.snapshot ?? '(snapshot unavailable)'
  const createLlmClient = deps.createLlmClient ?? createDeviceLlmClient
  const llm = createLlmClient(deps.gatewayConfig, leader, deps.url, initialSnapshot, deps.task)
  let leaderSummary: DeviceAgentRun['summary'] = null
  let leaderFatalError: string | null = null
  let leaderFinished = false

  try {
    for (let turn = 1; turn <= deps.maxTurns; turn++) {
      deps.onDeviceStatus(leader.selectionId, 'awaiting_gateway', null)
      let next: NextActionResult
      try {
        next = await llm.nextAction()
      } catch (error) {
        leaderFatalError = error instanceof Error ? error.message : String(error)
        break
      }

      if (next.done) {
        leaderSummary = next.summary
        leaderFinished = true
        break
      }
      if (!next.command) {
        leaderFatalError = 'LLM 未返回命令且未声明完成'
        break
      }

      const activeRuntimes = runtimes.filter((runtime) => runtime.active)
      const executions = await Promise.all(
        activeRuntimes.map((runtime) => executeAction(deps, runtime, turn, next)),
      )
      const leaderExecution = executions.find(
        (execution) => execution.runtime.device.selectionId === leader.selectionId,
      )
      if (!leaderExecution) {
        leaderFatalError = '主设备执行器不可用'
        break
      }

      llm.reportResult(leaderExecution.report)
      await Promise.all(
        executions
          .filter(
            (execution) =>
              execution.runtime.device.selectionId !== leader.selectionId &&
              execution.step.status === 'failed',
          )
          .map(async (execution) => {
            try {
              await deps.onFollowerError({
                deviceId: execution.runtime.device.selectionId,
                stepIndex: execution.step.stepIndex,
                command: execution.step.command,
                error: execution.report.error ?? execution.step.output ?? '从设备工具调用执行失败',
              })
            } catch {
              // Failure to write a warning must not stop the shared Agent loop.
            }
          }),
      )
    }
  } finally {
    llm.close()
  }

  if (!leaderFinished && !leaderFatalError) {
    leaderFatalError = `Agent 达到最大轮数 ${deps.maxTurns}，未收到完成信号`
  }

  if (leaderFatalError) {
    leaderRuntime.deviceRun.status = 'failed'
    leaderRuntime.deviceRun.error = leaderFatalError
    for (const runtime of runtimes.slice(1)) {
      if (!runtime.active) continue
      runtime.active = false
      runtime.deviceRun.status = 'cancelled'
      runtime.deviceRun.error = '主设备 Agent 未完成，未继续执行'
      deps.onDeviceStatus(runtime.device.selectionId, 'cancelled', runtime.deviceRun.error)
    }
  }

  await Promise.all(
    runtimes.map((runtime, index) =>
      finalizeRuntime(deps, runtime, index === 0 ? leaderSummary : null),
    ),
  )
  return runtimes.map((runtime) => runtime.deviceRun)
}

function createRuntime(
  deps: SharedDeviceAgentDeps,
  device: ScreenshotDevicePresetSnapshot,
): DeviceRuntime {
  const artifacts = deps.artifacts.get(device.selectionId)
  if (!artifacts) throw new Error(`设备 ${device.selectionId} 缺少运行目录`)
  const mapping = mapToDevice(device)
  return {
    device,
    artifacts,
    session: sanitizeSessionId(`agent-${deps.runId.slice(-8)}-${device.selectionId}`),
    safeDeviceId: sanitizeDeviceDir(device.selectionId),
    recordedSteps: [],
    startedAt: Date.now(),
    active: false,
    lastScreenshotPath: null,
    lastSnapshot: null,
    deviceRun: {
      deviceId: device.selectionId,
      platformId: device.platformId,
      presetId: device.presetId,
      presetName: device.presetName,
      cliDeviceName: mapping.cliDeviceName,
      status: 'queued',
      steps: [],
      finalScreenshotPath: null,
      finalScreenshotUrl: null,
      testScriptUrl: null,
      error: null,
      summary: null,
      durationMs: null,
    },
  }
}

async function launchRuntime(deps: SharedDeviceAgentDeps, runtime: DeviceRuntime): Promise<void> {
  const { device, deviceRun, session } = runtime
  const mapping = mapToDevice(device)
  deps.onDeviceStatus(device.selectionId, 'launching', null)
  deviceRun.status = 'launching'

  try {
    const openResult = await deps.cliBridge.open(session, deps.url, mapping.cliDeviceName)
    if (!openResult.ok) {
      const error = resultError(openResult, 'Playwright CLI 启动失败')
      appendStep(deps, runtime, {
        stepIndex: 0,
        command: 'goto',
        args: [deps.url],
        purpose: '打开页面',
        status: 'failed',
        info: null,
        output: error,
        error,
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
      throw new Error(error)
    }

    if (mapping.needsResize) {
      await deps.cliBridge.resize(session, device.viewport.width, device.viewport.height)
    }

    const before = await tryPrepareObservation(deps.cliBridge, session)
    const observation = await observePage(deps, runtime, 0, 'goto', before)

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
    runtime.active = true
    deviceRun.status = 'running'
    deps.onDeviceStatus(device.selectionId, 'running', null)
  } catch (error) {
    runtime.active = false
    deviceRun.status = 'failed'
    deviceRun.error = error instanceof Error ? error.message : String(error)
    deviceRun.durationMs = Date.now() - runtime.startedAt
    deps.onDeviceStatus(device.selectionId, 'failed', deviceRun.error)
  }
}

async function executeAction(
  deps: SharedDeviceAgentDeps,
  runtime: DeviceRuntime,
  stepIndex: number,
  next: NextActionResult,
): Promise<ExecutedAction> {
  const command = next.command!
  const deviceId = runtime.device.selectionId
  const startedAt = new Date().toISOString()
  deps.onDeviceStatus(deviceId, 'executing', null)

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
    result = {
      ok: false,
      output: '',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  deps.onDeviceStatus(deviceId, 'capturing', null)
  const observation = await observePage(deps, runtime, stepIndex, command, before)

  if (result.ok) {
    runtime.recordedSteps.push({ command, args: [...next.args], purpose: next.purpose, locator })
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
    startedAt,
    completedAt,
    durationMs: Math.max(0, new Date(completedAt).getTime() - new Date(startedAt).getTime()),
  }
  appendStep(deps, runtime, step)

  return {
    runtime,
    step,
    report: {
      ok: result.ok,
      error: result.error,
      command,
      output: limitOutput(result.output),
      wait: observation.wait,
      page: observation.page,
      snapshot: observation.snapshot,
      snapshotMeta: observation.snapshotMeta,
      screenshotUrl: observation.screenshotUrl,
    },
  }
}

interface PageObservation {
  wait: AgentWaitResult
  page: AgentPageState
  snapshot: string | null
  snapshotMeta: AgentSnapshotMeta | null
  screenshotUrl: string | null
}

async function observePage(
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
    snapshotResult = {
      ok: false,
      output: '',
      error: error instanceof Error ? error.message : String(error),
    }
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
      // Keep the browser observation usable even when artifact persistence fails.
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
  const paddedStep = String(stepIndex).padStart(2, '0')
  const shotPath = `${runtime.artifacts.screenshotsDir}/${paddedStep}.png`
  let shotResult: CliResult
  try {
    shotResult = await deps.cliBridge.screenshot(runtime.session, shotPath)
  } catch {
    shotResult = { ok: false, output: '', error: '截图调用失败' }
  }
  let screenshotUrl: string | null = null
  if (shotResult.ok) {
    runtime.lastScreenshotPath = shotPath
    screenshotUrl = `/outputs/${deps.runId}/agent/${runtime.safeDeviceId}/steps/${paddedStep}.png`
  }

  return {
    wait: readiness.wait,
    page: readiness.page,
    snapshot,
    snapshotMeta,
    screenshotUrl,
  }
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

async function finalizeRuntime(
  deps: SharedDeviceAgentDeps,
  runtime: DeviceRuntime,
  summary: DeviceAgentRun['summary'],
): Promise<void> {
  const { deviceRun, device, artifacts } = runtime
  if (summary) deviceRun.summary = summary

  try {
    if (deviceRun.status !== 'failed' && deviceRun.status !== 'cancelled') {
      const specContent = generateSpec(device, deps.url, deps.task, runtime.recordedSteps)
      await writeFile(`${artifacts.specDir}/agent.spec.ts`, specContent, 'utf8')
      deviceRun.testScriptUrl = `/outputs/${deps.runId}/agent/${runtime.safeDeviceId}/agent.spec.ts`

      const isLeader = device.selectionId === deps.devices[0]?.selectionId
      const actionSteps = deviceRun.steps.slice(1)
      const allLeaderActionsFailed =
        isLeader && actionSteps.length > 0 && actionSteps.every((step) => step.status === 'failed')
      deviceRun.status = allLeaderActionsFailed ? 'failed' : 'completed'
      deviceRun.error = allLeaderActionsFailed ? '主设备所有 Agent 操作均执行失败' : null
    }
  } catch (error) {
    deviceRun.status = 'failed'
    deviceRun.error = error instanceof Error ? error.message : String(error)
  } finally {
    try {
      let finalScreenshotSaved = false
      if (runtime.lastScreenshotPath) {
        await copyFile(runtime.lastScreenshotPath, artifacts.finalScreenshotPath)
        finalScreenshotSaved = true
      } else {
        const finalShot = await deps.cliBridge.screenshot(
          runtime.session,
          artifacts.finalScreenshotPath,
        )
        finalScreenshotSaved = finalShot.ok
      }
      if (finalScreenshotSaved) {
        deviceRun.finalScreenshotPath = `data/runs/${deps.runId}/${runtime.safeDeviceId}.png`
        deviceRun.finalScreenshotUrl = `/outputs/${deps.runId}/${runtime.safeDeviceId}.png`
      }
    } catch {
      deviceRun.finalScreenshotPath = null
      deviceRun.finalScreenshotUrl = null
    }
    try {
      await deps.cliBridge.close(runtime.session)
    } catch {
      // Session cleanup is best-effort.
    }
  }

  runtime.active = false
  deviceRun.durationMs = Date.now() - runtime.startedAt
  deps.onDeviceStatus(device.selectionId, deviceRun.status, deviceRun.error)
}

function appendStep(
  deps: SharedDeviceAgentDeps,
  runtime: DeviceRuntime,
  step: DeviceAgentStep,
): void {
  runtime.deviceRun.steps.push(step)
  deps.onDeviceStep(runtime.device.selectionId, step)
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
