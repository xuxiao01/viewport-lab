import type {
  AgentRunStatus,
  DeviceAgentRun,
  DeviceAgentStep,
  ScreenshotDevicePresetSnapshot,
} from '@viewport-lab/shared'
import { writeFile } from 'node:fs/promises'

import type { AgentCliBridge } from './cli-bridge.js'
import { sanitizeSessionId } from './cli-bridge.js'
import type { AgentGatewayConfig } from './config.js'
import { mapToDevice } from './device-mapper.js'
import type { DeviceLlmClient } from './llm-client.js'
import { createDeviceLlmClient } from './llm-client.js'
import type { RecordedStep } from './test-script-generator.js'
import { generateSpec } from './test-script-generator.js'
import { sanitizeDeviceDir } from './recorder.js'

const SCREENSHOT_DELAY_MS = 500

function snapshotFilePath(dir: string, stepIndex: number): string {
  return `${dir}/${String(stepIndex).padStart(2, '0')}.txt`
}

export interface DeviceAgentDeps {
  device: ScreenshotDevicePresetSnapshot
  url: string
  task: string
  note: string
  maxTurns: number
  runId: string
  gatewayConfig: AgentGatewayConfig | null
  cliBridge: AgentCliBridge
  screenshotsDir: string
  snapshotsDir: string
  specDir: string
  onDeviceStatus: (deviceId: string, status: AgentRunStatus, error: string | null) => void
  onDeviceStep: (deviceId: string, step: DeviceAgentStep) => void
}

export async function runDeviceAgent(deps: DeviceAgentDeps): Promise<DeviceAgentRun> {
  const { device, url, task, maxTurns, runId, gatewayConfig, cliBridge } = deps
  const deviceId = device.selectionId
  const safeDeviceId = sanitizeDeviceDir(deviceId)
  const mapping = mapToDevice(device)
  const session = sanitizeSessionId(`agent-${runId.slice(0, 8)}-${deviceId}`)
  const steps: DeviceAgentStep[] = []
  const recordedSteps: RecordedStep[] = []

  const deviceRun: DeviceAgentRun = {
    deviceId,
    platformId: device.platformId,
    presetId: device.presetId,
    presetName: device.presetName,
    cliDeviceName: mapping.cliDeviceName,
    status: 'launching',
    steps,
    testScriptUrl: null,
    error: null,
    summary: null,
    durationMs: null,
  }

  let llm: DeviceLlmClient | null = null
  const startedAt = Date.now()

  try {
    deps.onDeviceStatus(deviceId, 'launching', null)

    await cliBridge.open(session, url, mapping.cliDeviceName)
    if (mapping.needsResize) {
      await cliBridge.resize(session, device.viewport.width, device.viewport.height)
    }

    const snapshotResult = await cliBridge.snapshot(session)
    const initialSnapshot = snapshotResult.ok ? snapshotResult.output : '(snapshot unavailable)'
    await writeFile(snapshotFilePath(deps.snapshotsDir, 0), initialSnapshot, 'utf8')

    const initialShotPath = `${deps.screenshotsDir}/00.png`
    await cliBridge.screenshot(session, initialShotPath)

    const initialStep: DeviceAgentStep = {
      stepIndex: 0,
      command: 'goto',
      args: [url],
      purpose: '打开页面',
      status: 'success',
      info: null,
      output: null,
      snapshot: initialSnapshot,
      screenshotUrl: `/agent-outputs/${runId}/${safeDeviceId}/screenshots/00.png`,
      locator: null,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
    }
    steps.push(initialStep)
    deps.onDeviceStep(deviceId, initialStep)

    llm = createDeviceLlmClient(gatewayConfig, device, url, initialSnapshot, task)

    for (let turn = 1; turn <= maxTurns; turn++) {
      deps.onDeviceStatus(deviceId, 'awaiting_gateway', null)

      const next = await llm.nextAction()
      if (next.done) {
        if (next.summary) deviceRun.summary = next.summary
        break
      }

      const command = next.command
      if (!command) {
        deviceRun.status = 'failed'
        deviceRun.error = 'LLM 未返回命令且未声明完成'
        break
      }

      deps.onDeviceStatus(deviceId, 'executing', null)

      const stepIndex = recordedSteps.length + 1
      const stepStartedAt = new Date().toISOString()
      const result = await cliBridge.execute(session, command, next.args)
      const stepCompletedAt = new Date().toISOString()
      if (command === 'snapshot' && result.output) {
        await writeFile(snapshotFilePath(deps.snapshotsDir, stepIndex), result.output, 'utf8')
      }

      let screenshotUrl: string | null = null
      if (command !== 'snapshot' && command !== 'find') {
        deps.onDeviceStatus(deviceId, 'capturing', null)
        await delay(SCREENSHOT_DELAY_MS)
        const shotPath = `${deps.screenshotsDir}/${String(stepIndex).padStart(2, '0')}.png`
        const shotResult = await cliBridge.screenshot(session, shotPath)
        if (shotResult.ok) {
          screenshotUrl = `/agent-outputs/${runId}/${safeDeviceId}/screenshots/${String(stepIndex).padStart(2, '0')}.png`
        }
      }

      let locator: string | null = null
      const ref = next.args.find((a) => /^[fe]\d/.test(a)) ?? null
      if (
        result.ok &&
        ref &&
        command !== 'snapshot' &&
        command !== 'find' &&
        command !== 'goto' &&
        command !== 'go-back' &&
        command !== 'go-forward' &&
        command !== 'reload' &&
        command !== 'press' &&
        command !== 'eval'
      ) {
        const locResult = await cliBridge.generateLocator(session, ref)
        if (locResult.ok && locResult.output) {
          locator = locResult.output
        }
      }

      if (result.ok) {
        recordedSteps.push({ command, args: next.args, purpose: next.purpose, locator })
      }

      const stepStatus = result.ok ? 'success' : 'failed'
      const step: DeviceAgentStep = {
        stepIndex,
        command,
        args: next.args,
        purpose: next.purpose,
        status: stepStatus,
        info: next.info,
        output: result.output.slice(0, 4000),
        snapshot: command === 'snapshot' ? result.output : null,
        screenshotUrl,
        locator,
        startedAt: stepStartedAt,
        completedAt: stepCompletedAt,
        durationMs: Math.max(
          0,
          new Date(stepCompletedAt).getTime() - new Date(stepStartedAt).getTime(),
        ),
      }
      steps.push(step)
      deps.onDeviceStep(deviceId, step)

      llm.reportResult({
        ok: result.ok,
        error: result.error,
        output: result.output,
        screenshotUrl,
      })

      if (!result.ok && result.error) {
        // continue even on error - LLM should self-correct
      }
    }

    const specContent = generateSpec(device, url, task, recordedSteps)
    const specPath = `${deps.specDir}/agent.spec.ts`
    await writeFile(specPath, specContent, 'utf8')
    deviceRun.testScriptUrl = `/agent-outputs/${runId}/${safeDeviceId}/agent.spec.ts`

    deviceRun.status = deviceRun.summary ? 'completed' : 'completed'
    deviceRun.durationMs = Date.now() - startedAt
    deps.onDeviceStatus(deviceId, deviceRun.status, null)
  } catch (error) {
    deviceRun.status = 'failed'
    deviceRun.error = error instanceof Error ? error.message : String(error)
    deviceRun.durationMs = Date.now() - startedAt
    deps.onDeviceStatus(deviceId, 'failed', deviceRun.error)
  } finally {
    llm?.close()
    try {
      await cliBridge.close(session)
    } catch {
      // ignore close errors
    }
  }

  return deviceRun
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
