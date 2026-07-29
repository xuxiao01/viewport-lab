import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { DeviceAgentRun, ScreenshotDevicePresetSnapshot } from '@viewport-lab/shared'

import type { AgentCliBridge, AgentViewportOptions, CliResult } from './cli-bridge.js'
import type { DeviceAgentArtifacts } from './device-agent.js'
import { runSharedDeviceAgent } from './device-agent.js'
import type { ActionResultReport, DeviceLlmClient, NextActionResult } from './llm-client.js'

function device(
  selectionId: string,
  presetName: string,
  width = 390,
  height = 844,
): ScreenshotDevicePresetSnapshot {
  return {
    selectionId,
    platformId: 'ios-phone',
    platformName: '苹果手机',
    presetId: selectionId,
    presetName,
    viewport: { width, height },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    fullPage: false,
    readySelector: '',
    captureDelayMs: 0,
  }
}

class FakeLlmClient implements DeviceLlmClient {
  readonly reports: ActionResultReport[] = []
  nextActionCalls = 0

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
  openCalls: string[] = []
  resizeCalls: Array<{ width: number; height: number }> = []
  executeCalls: Array<{ session: string; command: string; args: string[] }> = []
  callOrder: string[] = []
  snapshotCalls = 0
  snapshotOutputs: string[] = []
  failCommand: string | null = null
  failScreenshotFor: string | null = null
  waitStatus: 'ready' | 'timed_out' = 'ready'
  throwOnReadiness = false
  throwOnScreenshot = false
  largeOutput = false

  async open(session: string, options: AgentViewportOptions): Promise<CliResult> {
    this.openCalls.push(session)
    this.callOrder.push(`open:${options.width}x${options.height}@${options.deviceScaleFactor}`)
    return success('opened')
  }

  async resize(_session: string, width: number, height: number): Promise<CliResult> {
    this.resizeCalls.push({ width, height })
    this.callOrder.push(`resize:${width}x${height}`)
    return success('resized')
  }

  async configureViewport(
    session: string,
    options: AgentViewportOptions,
  ): Promise<CliResult> {
    return this.resize(session, options.width, options.height)
  }

  async snapshot(): Promise<CliResult> {
    this.snapshotCalls += 1
    return success(this.snapshotOutputs.shift() ?? '- button "继续" [ref=f1e2]')
  }

  async screenshot(_session: string, filename: string): Promise<CliResult> {
    if (this.throwOnScreenshot) throw new Error('screenshot unavailable')
    if (this.failScreenshotFor && filename.includes(this.failScreenshotFor)) {
      return { ok: false, output: '', error: 'final screenshot unavailable' }
    }
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
    this.callOrder.push(`${command}:${args.join(' ')}`)
    if (command === this.failCommand)
      return { ok: false, output: '', error: 'leader action failed' }
    return success(this.largeOutput ? 'x'.repeat(5_001) : `${command} completed`)
  }

  async close(): Promise<CliResult> {
    return success('closed')
  }

  async closeAll(): Promise<void> {}
}

test('runs the LLM once in the leader then resizes the same session for every final viewport', async () => {
  await withArtifacts(async (root) => {
    const devices = [device('leader', '主设备', 390, 844), device('follower', '从设备', 430, 932)]
    const bridge = new FakeCliBridge()
    const llm = new FakeLlmClient([action('click', ['f1e2']), done()])
    const runs = await run(devices, root, bridge, llm)

    assert.equal(bridge.openCalls.length, 1)
    assert.equal(bridge.executeCalls.length, 2)
    assert.deepEqual(bridge.callOrder.slice(0, 2), [
      'open:390x844@3',
      'goto:https://example.com',
    ])
    assert.equal(llm.reports.length, 1)
    assert.deepEqual(bridge.resizeCalls.slice(-2), [
      { width: 390, height: 844 },
      { width: 430, height: 932 },
    ])
    assert.equal(runs[0]?.steps.length, 2)
    assert.equal(runs[1]?.steps.length, 0)
    assert.deepEqual(
      runs.map((item) => item.status),
      ['completed', 'completed'],
    )
    assert.ok(runs.every((item) => item.finalScreenshotUrl))
    assert.equal(runs[1]?.testScriptUrl, null)
    assert.equal(runs[0]?.cliDeviceName, '')
    const spec = await readFile(join(root, 'leader', 'agent.spec.ts'), 'utf8')
    assert.match(spec, /viewport: \{ width: 390, height: 844 \}/)
    assert.match(spec, /screen: \{ width: 390, height: 844 \}/)
    assert.match(spec, /deviceScaleFactor: 3/)
    assert.match(spec, /isMobile: true/)
    assert.match(spec, /hasTouch: true/)
  })
})

test('records post-action state even when the leader action fails', async () => {
  await withArtifacts(async (root) => {
    const bridge = new FakeCliBridge()
    bridge.failCommand = 'click'
    bridge.waitStatus = 'timed_out'
    bridge.snapshotOutputs.push('- main [ref=e1]', '- alert: action failed')
    const llm = new FakeLlmClient([action('click', ['f1e2']), done()])
    const [deviceRun] = await run([device('leader', '主设备')], root, bridge, llm)

    assert.equal(deviceRun?.steps[1]?.status, 'failed')
    assert.equal(deviceRun?.steps[1]?.wait?.status, 'timed_out')
    assert.equal(deviceRun?.steps[1]?.snapshot, '- alert: action failed')
    assert.equal(llm.reports[0]?.ok, false)
  })
})

test('deduplicates snapshots and caps the model snapshot', async () => {
  await withArtifacts(async (root) => {
    const bridge = new FakeCliBridge()
    const initial = '- main [ref=e1]'
    bridge.snapshotOutputs.push(initial, initial, 'x'.repeat(40_001))
    const llm = new FakeLlmClient([action('press', ['Tab']), action('press', ['Enter']), done()])
    const [deviceRun] = await run([device('leader', '主设备')], root, bridge, llm)

    assert.equal(deviceRun?.steps[1]?.snapshot, null)
    assert.equal(deviceRun?.steps[1]?.snapshotMeta?.sameAsStepIndex, 0)
    assert.equal(deviceRun?.steps[2]?.snapshot?.length, 40_000)
    assert.equal(deviceRun?.steps[2]?.snapshotMeta?.truncated, true)
  })
})

test('does not capture any target when the leader cannot finish', async () => {
  await withArtifacts(async (root) => {
    const devices = [device('leader', '主设备'), device('follower', '从设备', 430, 932)]
    const bridge = new FakeCliBridge()
    const llm = new FakeLlmClient([action('click', ['f1e2'])])
    const runs = await run(devices, root, bridge, llm, { maxTurns: 1 })

    assert.deepEqual(
      runs.map((item) => item.status),
      ['failed', 'failed'],
    )
    assert.equal(runs[1]?.error, '主设备 Agent 未完成，未生成视口截图')
    assert.equal(
      bridge.resizeCalls.some((call) => call.width === 430 && call.height === 932),
      false,
    )
  })
})

test('only replaces selected viewport captures while preserving other device results', async () => {
  await withArtifacts(async (root) => {
    const devices = [device('leader', '主设备'), device('follower', '从设备', 430, 932)]
    const bridge = new FakeCliBridge()
    const existing: DeviceAgentRun[] = [
      makeExisting(devices[0]!, true),
      makeExisting(devices[1]!, false),
    ]
    const llm = new FakeLlmClient([done()])
    const runs = await run(devices, root, bridge, llm, {
      captureDeviceIds: new Set(['follower']),
      existingDeviceRuns: existing,
    })

    assert.equal(runs[0]?.finalScreenshotUrl, '/old-leader.png')
    assert.equal(runs[0]?.steps.length, 1)
    assert.ok(runs[1]?.finalScreenshotUrl?.includes('follower.png'))
    assert.equal(runs[1]?.steps.length, 0)
  })
})

test('marks only the viewport whose final capture fails as failed', async () => {
  await withArtifacts(async (root) => {
    const devices = [device('leader', '主设备'), device('follower', '从设备')]
    const bridge = new FakeCliBridge()
    bridge.failScreenshotFor = 'follower.png'
    const runs = await run(devices, root, bridge, new FakeLlmClient([done()]))
    assert.deepEqual(
      runs.map((item) => item.status),
      ['completed', 'failed'],
    )
  })
})

function action(command: string, args: string[]): NextActionResult {
  return { command, args, purpose: `执行 ${command}`, info: null, done: false, summary: null }
}

function done(): NextActionResult {
  return { command: null, args: [], purpose: '', info: null, done: true, summary: null }
}

function success(output: string): CliResult {
  return { ok: true, output, error: null }
}

function makeExisting(device: ScreenshotDevicePresetSnapshot, leader: boolean): DeviceAgentRun {
  return {
    deviceId: device.selectionId,
    platformId: device.platformId,
    presetId: device.presetId,
    presetName: device.presetName,
    cliDeviceName: 'old-device',
    status: 'completed',
    steps: [],
    finalScreenshotPath: leader
      ? 'data/runs/test-run/leader.png'
      : 'data/runs/test-run/follower.png',
    finalScreenshotUrl: leader ? '/old-leader.png' : '/old-follower.png',
    testScriptUrl: null,
    error: null,
    summary: null,
    durationMs: 1,
  }
}

async function run(
  devices: ScreenshotDevicePresetSnapshot[],
  root: string,
  bridge: FakeCliBridge,
  llm: FakeLlmClient,
  overrides: Partial<Parameters<typeof runSharedDeviceAgent>[0]> = {},
): Promise<DeviceAgentRun[]> {
  return runSharedDeviceAgent({
    devices,
    artifacts: await createArtifacts(root, devices),
    url: 'https://example.com',
    task: '测试任务',
    maxTurns: 5,
    runId: 'test-run',
    gatewayConfig: null,
    cliBridge: bridge,
    screenshotDelayMs: 0,
    onDeviceStatus: () => undefined,
    onDeviceStep: () => undefined,
    createLlmClient: () => llm,
    ...overrides,
  })
}

async function withArtifacts(runCase: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viewport-lab-agent-'))
  try {
    await runCase(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function createArtifacts(
  root: string,
  devices: ScreenshotDevicePresetSnapshot[],
): Promise<Map<string, DeviceAgentArtifacts>> {
  return new Map(
    await Promise.all(
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
    ),
  )
}
