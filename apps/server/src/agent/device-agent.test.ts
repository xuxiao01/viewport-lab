import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ScreenshotDevicePresetSnapshot } from '@viewport-lab/shared'

import type { AgentCliBridge, CliResult } from './cli-bridge.js'
import type { DeviceAgentArtifacts } from './device-agent.js'
import { runSharedDeviceAgent } from './device-agent.js'
import type { ActionResultReport, DeviceLlmClient, NextActionResult } from './llm-client.js'

function device(selectionId: string, presetName: string): ScreenshotDevicePresetSnapshot {
  return {
    selectionId,
    platformId: 'ios-phone',
    platformName: '苹果手机',
    presetId: selectionId,
    presetName,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    fullPage: false,
    readySelector: '',
    captureDelayMs: 0,
  }
}

class FakeLlmClient implements DeviceLlmClient {
  nextActionCalls = 0
  readonly reports: ActionResultReport[] = []

  constructor(private readonly actions: NextActionResult[]) {}

  async nextAction(): Promise<NextActionResult> {
    this.nextActionCalls += 1
    const action = this.actions.shift()
    if (!action) throw new Error('测试没有配置下一步动作')
    return action
  }

  reportResult(report: ActionResultReport): void {
    this.reports.push(report)
  }

  close(): void {}
}

class FakeCliBridge implements AgentCliBridge {
  readonly executeCalls: Array<{ session: string; command: string; args: string[] }> = []
  snapshotCalls = 0
  readonly snapshotOutputs: string[] = []
  failFollowerCommand: string | null = null
  failLeaderCommand: string | null = null
  waitStatus: 'ready' | 'timed_out' = 'ready'
  throwOnReadiness = false
  throwOnScreenshot = false
  largeOutput = false
  blockedFollower: { promise: Promise<void>; release: () => void } | null = null

  async open(): Promise<CliResult> {
    return success('opened')
  }

  async resize(): Promise<CliResult> {
    return success('resized')
  }

  async snapshot(): Promise<CliResult> {
    this.snapshotCalls += 1
    return success(this.snapshotOutputs.shift() ?? '- button "继续" [ref=f1e2]')
  }

  async screenshot(_session: string, filename: string): Promise<CliResult> {
    if (this.throwOnScreenshot) throw new Error('screenshot unavailable')
    await writeFile(filename, 'image', 'utf8')
    return success(filename)
  }

  async generateLocator(): Promise<CliResult> {
    return success("getByRole('button', { name: '继续' })")
  }

  async runCode(_session: string, code: string): Promise<CliResult> {
    if (code.includes('preparedAt')) {
      return success(
        JSON.stringify({ url: 'https://example.com', title: 'Example', preparedAt: Date.now() }),
      )
    }
    if (this.throwOnReadiness) throw new Error('readiness observer unavailable')
    return success(
      JSON.stringify({
        wait: {
          status: this.waitStatus,
          reason: this.waitStatus === 'ready' ? 'page_stable' : 'readiness_deadline',
          elapsedMs: 10,
          signals: {
            navigation: { status: 'skipped', detail: 'not_navigation' },
            network: { status: 'ready', detail: 'network_quiet' },
            dom: { status: 'ready', detail: 'dom_quiet' },
            fonts: { status: 'ready', detail: 'fonts_loaded' },
            images: { status: 'ready', detail: 'visible_images_decoded' },
            paint: { status: 'ready', detail: 'two_animation_frames' },
          },
        },
        page: { url: 'https://example.com', title: 'Example' },
      }),
    )
  }

  async execute(session: string, command: string, args: string[]): Promise<CliResult> {
    this.executeCalls.push({ session, command, args: [...args] })
    if (session.includes('follower') && this.blockedFollower) {
      await this.blockedFollower.promise
      this.blockedFollower = null
    }
    if (session.includes('follower') && command === this.failFollowerCommand) {
      return { ok: false, output: '', error: 'target ref not found' }
    }
    if (session.includes('leader') && command === this.failLeaderCommand) {
      return { ok: false, output: '', error: 'leader action failed' }
    }
    return success(this.largeOutput ? 'x'.repeat(5_001) : `${command} completed`)
  }

  async close(): Promise<CliResult> {
    return success('closed')
  }

  async closeAll(): Promise<void> {}
}

test('waits for every device before asking the single LLM for the next action', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'viewport-lab-agent-'))
  try {
    const devices = [device('leader', '主设备'), device('follower', '从设备')]
    const artifacts = await createArtifacts(testDir, devices)
    const bridge = new FakeCliBridge()
    bridge.blockedFollower = deferred()
    const llm = new FakeLlmClient([action('click', ['f1e2']), done()])
    let llmCreateCount = 0

    const runPromise = runSharedDeviceAgent({
      devices,
      artifacts,
      url: 'https://example.com',
      task: '点击继续',
      maxTurns: 5,
      runId: 'test-run',
      gatewayConfig: null,
      cliBridge: bridge,
      screenshotDelayMs: 0,
      onDeviceStatus: () => undefined,
      onDeviceStep: () => undefined,
      onFollowerError: () => undefined,
      createLlmClient: () => {
        llmCreateCount += 1
        return llm
      },
    })

    await waitFor(() => bridge.executeCalls.some((call) => call.session.includes('follower')))
    assert.equal(llm.nextActionCalls, 1)
    bridge.blockedFollower.release()

    const runs = await runPromise
    assert.equal(llmCreateCount, 1)
    assert.equal(llm.nextActionCalls, 2)
    assert.equal(llm.reports.length, 1)
    assert.deepEqual(
      bridge.executeCalls.map(({ command, args }) => ({ command, args })),
      [
        { command: 'click', args: ['f1e2'] },
        { command: 'click', args: ['f1e2'] },
      ],
    )
    assert.deepEqual(
      runs.map((run) => run.status),
      ['completed', 'completed'],
    )
  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
})

test('records a follower action failure and continues without reporting it to the LLM', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'viewport-lab-agent-'))
  try {
    const devices = [device('leader', '主设备'), device('follower', '从设备')]
    const artifacts = await createArtifacts(testDir, devices)
    const bridge = new FakeCliBridge()
    bridge.failFollowerCommand = 'click'
    const llm = new FakeLlmClient([action('click', ['f1e2']), action('press', ['Enter']), done()])
    const followerErrors: string[] = []

    const runs = await runSharedDeviceAgent({
      devices,
      artifacts,
      url: 'https://example.com',
      task: '继续并确认',
      maxTurns: 5,
      runId: 'test-run',
      gatewayConfig: null,
      cliBridge: bridge,
      screenshotDelayMs: 0,
      onDeviceStatus: () => undefined,
      onDeviceStep: () => undefined,
      onFollowerError: ({ error }) => {
        followerErrors.push(error)
      },
      createLlmClient: () => llm,
    })

    const followerRun = runs[1]!
    assert.equal(followerRun.status, 'completed')
    assert.deepEqual(
      followerRun.steps.map((step) => step.status),
      ['success', 'failed', 'success'],
    )
    assert.equal(followerRun.steps[1]?.output, 'target ref not found')
    assert.deepEqual(followerErrors, ['target ref not found'])
    assert.equal(llm.reports.length, 2)
    assert.ok(llm.reports.every((report) => report.ok))
    assert.equal(bridge.executeCalls.filter((call) => call.session.includes('follower')).length, 2)
  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
})

test('captures post-action state even when the leader action fails or readiness times out', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'viewport-lab-agent-'))
  try {
    const devices = [device('leader', '主设备')]
    const artifacts = await createArtifacts(testDir, devices)
    const bridge = new FakeCliBridge()
    bridge.failLeaderCommand = 'click'
    bridge.waitStatus = 'timed_out'
    bridge.snapshotOutputs.push('- main [ref=e1]', '- alert: action failed')
    const llm = new FakeLlmClient([action('click', ['f1e2']), done()])

    const [run] = await runSharedDeviceAgent({
      devices,
      artifacts,
      url: 'https://example.com',
      task: '点击继续',
      maxTurns: 5,
      runId: 'test-run',
      gatewayConfig: null,
      cliBridge: bridge,
      screenshotDelayMs: 0,
      onDeviceStatus: () => undefined,
      onDeviceStep: () => undefined,
      onFollowerError: () => undefined,
      createLlmClient: () => llm,
    })

    assert.equal(run?.steps[1]?.status, 'failed')
    assert.equal(run?.steps[1]?.wait?.status, 'timed_out')
    assert.equal(run?.steps[1]?.snapshot, '- alert: action failed')
    assert.ok(run?.steps[1]?.screenshotUrl)
    assert.equal(llm.reports[0]?.ok, false)
    assert.equal(llm.reports[0]?.wait.status, 'timed_out')
    assert.equal(bridge.snapshotCalls, 2)
  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
})

test('deduplicates identical snapshots and caps changed model snapshots at 40000 characters', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'viewport-lab-agent-'))
  try {
    const devices = [device('leader', '主设备')]
    const artifacts = await createArtifacts(testDir, devices)
    const bridge = new FakeCliBridge()
    const initial = '- main [ref=e1]'
    const oversized = 'x'.repeat(40_001)
    bridge.snapshotOutputs.push(initial, initial, oversized)
    const llm = new FakeLlmClient([action('press', ['Tab']), action('press', ['Enter']), done()])

    const [run] = await runSharedDeviceAgent({
      devices,
      artifacts,
      url: 'https://example.com',
      task: '操作页面',
      maxTurns: 5,
      runId: 'test-run',
      gatewayConfig: null,
      cliBridge: bridge,
      screenshotDelayMs: 0,
      onDeviceStatus: () => undefined,
      onDeviceStep: () => undefined,
      onFollowerError: () => undefined,
      createLlmClient: () => llm,
    })

    assert.equal(run?.steps[1]?.snapshot, null)
    assert.equal(run?.steps[1]?.snapshotMeta?.changed, false)
    assert.equal(run?.steps[1]?.snapshotMeta?.sameAsStepIndex, 0)
    assert.equal(run?.steps[2]?.snapshot?.length, 40_000)
    assert.equal(run?.steps[2]?.snapshotMeta?.truncated, true)
    assert.equal(run?.steps[2]?.snapshotMeta?.originalChars, 40_001)
    assert.equal(llm.reports[0]?.snapshot, null)
  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
})

test('handles explicit snapshot through one automatic observation without executing snapshot command', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'viewport-lab-agent-'))
  try {
    const devices = [device('leader', '主设备')]
    const artifacts = await createArtifacts(testDir, devices)
    const bridge = new FakeCliBridge()
    const llm = new FakeLlmClient([action('snapshot', []), done()])

    const [run] = await runSharedDeviceAgent({
      devices,
      artifacts,
      url: 'https://example.com',
      task: '观察页面',
      maxTurns: 5,
      runId: 'test-run',
      gatewayConfig: null,
      cliBridge: bridge,
      screenshotDelayMs: 0,
      onDeviceStatus: () => undefined,
      onDeviceStep: () => undefined,
      onFollowerError: () => undefined,
      createLlmClient: () => llm,
    })

    assert.equal(bridge.executeCalls.length, 0)
    assert.equal(bridge.snapshotCalls, 2)
    assert.equal(run?.steps[1]?.output, 'Snapshot captured after page readiness.')
  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
})

test('keeps the run alive when page observation and screenshot calls throw', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'viewport-lab-agent-'))
  try {
    const devices = [device('leader', '主设备')]
    const artifacts = await createArtifacts(testDir, devices)
    const bridge = new FakeCliBridge()
    bridge.throwOnReadiness = true
    bridge.throwOnScreenshot = true
    const llm = new FakeLlmClient([action('click', ['f1e2']), done()])

    const [run] = await runSharedDeviceAgent({
      devices,
      artifacts,
      url: 'https://example.com',
      task: '点击继续',
      maxTurns: 5,
      runId: 'test-run',
      gatewayConfig: null,
      cliBridge: bridge,
      screenshotDelayMs: 0,
      onDeviceStatus: () => undefined,
      onDeviceStep: () => undefined,
      onFollowerError: () => undefined,
      createLlmClient: () => llm,
    })

    assert.equal(run?.status, 'completed')
    assert.equal(run?.steps[1]?.status, 'success')
    assert.equal(run?.steps[1]?.wait?.reason, 'observer_error')
    assert.equal(run?.steps[1]?.screenshotUrl, null)
  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
})

test('marks the shared run incomplete when the leader reaches max turns', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'viewport-lab-agent-'))
  try {
    const devices = [device('leader', '主设备'), device('follower', '从设备')]
    const artifacts = await createArtifacts(testDir, devices)
    const bridge = new FakeCliBridge()
    const llm = new FakeLlmClient([action('click', ['f1e2'])])

    const runs = await runSharedDeviceAgent({
      devices,
      artifacts,
      url: 'https://example.com',
      task: '点击继续',
      maxTurns: 1,
      runId: 'test-run',
      gatewayConfig: null,
      cliBridge: bridge,
      screenshotDelayMs: 0,
      onDeviceStatus: () => undefined,
      onDeviceStep: () => undefined,
      onFollowerError: () => undefined,
      createLlmClient: () => llm,
    })

    assert.deepEqual(
      runs.map((run) => ({ status: run.status, error: run.error })),
      [
        { status: 'failed', error: 'Agent 达到最大轮数 1，未收到完成信号' },
        { status: 'cancelled', error: '主设备 Agent 未完成，未继续执行' },
      ],
    )
  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
})

test('limits large action output before reporting it to the model', async () => {
  const testDir = await mkdtemp(join(tmpdir(), 'viewport-lab-agent-'))
  try {
    const devices = [device('leader', '主设备')]
    const artifacts = await createArtifacts(testDir, devices)
    const bridge = new FakeCliBridge()
    bridge.largeOutput = true
    const llm = new FakeLlmClient([action('eval', ['() => 1']), done()])

    const [run] = await runSharedDeviceAgent({
      devices,
      artifacts,
      url: 'https://example.com',
      task: '读取页面状态',
      maxTurns: 5,
      runId: 'test-run',
      gatewayConfig: null,
      cliBridge: bridge,
      screenshotDelayMs: 0,
      onDeviceStatus: () => undefined,
      onDeviceStep: () => undefined,
      onFollowerError: () => undefined,
      createLlmClient: () => llm,
    })

    assert.equal(run?.steps[1]?.output?.length, 4_000)
    assert.equal(llm.reports[0]?.output.length, 4_000)
  } finally {
    await rm(testDir, { recursive: true, force: true })
  }
})

function action(command: string, args: string[]): NextActionResult {
  return {
    command,
    args,
    purpose: `执行 ${command}`,
    info: null,
    done: false,
    summary: null,
  }
}

function done(): NextActionResult {
  return {
    command: null,
    args: [],
    purpose: '',
    info: null,
    done: true,
    summary: null,
  }
}

function success(output: string): CliResult {
  return { ok: true, output, error: null }
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {}
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待测试条件超时')
}

async function createArtifacts(
  root: string,
  devices: ScreenshotDevicePresetSnapshot[],
): Promise<Map<string, DeviceAgentArtifacts>> {
  const entries = await Promise.all(
    devices.map(async (item) => {
      const deviceDir = join(root, item.selectionId)
      const screenshotsDir = join(deviceDir, 'steps')
      const snapshotsDir = join(deviceDir, 'snapshots')
      await mkdir(screenshotsDir, { recursive: true })
      await mkdir(snapshotsDir, { recursive: true })
      return [
        item.selectionId,
        {
          screenshotsDir,
          snapshotsDir,
          specDir: deviceDir,
          finalScreenshotPath: join(root, `${item.selectionId}.png`),
        },
      ] as const
    }),
  )
  return new Map(entries)
}
