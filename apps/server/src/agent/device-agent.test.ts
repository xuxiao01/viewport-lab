import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ScreenshotDevicePresetSnapshot } from '@viewport-lab/shared'

import type { AgentCliBridge, AgentViewportOptions, CliResult } from './cli-bridge.js'
import type { DeviceAgentArtifacts } from './device-agent.js'
import { runDeviceAgent } from './device-agent.js'
import type { ActionResultReport, DeviceLlmClient, NextActionResult } from './llm-client.js'

function device(
  selectionId = 'iphone-390x844',
  width = 390,
  height = 844,
): ScreenshotDevicePresetSnapshot {
  return {
    selectionId,
    platformId: 'ios-phone',
    platformName: '苹果手机',
    presetId: selectionId,
    presetName: selectionId,
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

  constructor(
    private readonly actions: NextActionResult[],
    private readonly transientFailures = 0,
  ) {}

  async nextAction(): Promise<NextActionResult> {
    this.nextActionCalls += 1
    if (this.nextActionCalls <= this.transientFailures) {
      throw new Error('AI 网关调用失败：429 Too Many Requests')
    }
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
  readonly openCalls: Array<{ session: string; options: AgentViewportOptions }> = []
  readonly executeCalls: Array<{ session: string; command: string; args: string[] }> = []
  readonly closeCalls: string[] = []
  snapshotOutputs: string[] = []
  failCommand: string | null = null

  async open(session: string, options: AgentViewportOptions): Promise<CliResult> {
    this.openCalls.push({ session, options })
    return success('opened')
  }

  async snapshot(): Promise<CliResult> {
    return success(this.snapshotOutputs.shift() ?? '- button "继续" [ref=f1e2]')
  }

  async screenshot(_session: string, filename: string): Promise<CliResult> {
    const pngHeader = Buffer.alloc(24)
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(pngHeader)
    Buffer.from('IHDR').copy(pngHeader, 12)
    pngHeader.writeUInt32BE(1170, 16)
    pngHeader.writeUInt32BE(2532, 20)
    await writeFile(filename, pngHeader)
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
    if (code.includes('innerWidth')) {
      return success(
        JSON.stringify({
          innerWidth: 390,
          innerHeight: 844,
          screenWidth: 390,
          screenHeight: 844,
          devicePixelRatio: 3,
          maxTouchPoints: 1,
          pointerCoarse: true,
          visualViewportWidth: 390,
          visualViewportHeight: 844,
          visualViewportScale: 1,
          viewportMetaWidth: null,
        }),
      )
    }
    return success(
      JSON.stringify({
        wait: {
          status: 'ready',
          reason: 'page_stable',
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
    if (command === this.failCommand) return { ok: false, output: '', error: 'action failed' }
    return success(`${command} completed`)
  }

  async close(session: string): Promise<CliResult> {
    this.closeCalls.push(session)
    return success('closed')
  }
}

test('runs a complete independent Agent with the exact device context options', async () => {
  await withArtifacts(async (artifacts) => {
    const bridge = new FakeCliBridge()
    const llm = new FakeLlmClient([action('click', ['f1e2']), done()])
    const run = await execute(device(), artifacts, bridge, llm)

    assert.equal(bridge.openCalls.length, 1)
    assert.deepEqual(bridge.openCalls[0]?.options, {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
    })
    assert.equal(llm.reports.length, 1)
    assert.equal(run.status, 'completed')
    assert.equal(run.steps.length, 2)
    assert.equal(run.replaySteps.length, 0)
    assert.equal(run.screenshotPixelSize?.width, 1170)
    assert.equal(run.screenshotPixelSize?.height, 2532)
    assert.equal(run.viewportMetrics?.screenWidth, 390)
    assert.equal(run.finalScreenshotUrl, '/outputs/test-run/iphone-390x844.png')
    assert.equal(bridge.closeCalls.length, 1)
  })
})

test('two devices use separate browser sessions and separate model conversations', async () => {
  await withArtifacts(async (firstArtifacts, root) => {
    const secondArtifacts = await createArtifacts(root, 'ipad-820x1180')
    const firstBridge = new FakeCliBridge()
    const secondBridge = new FakeCliBridge()
    const firstLlm = new FakeLlmClient([action('click', ['f1']), done()])
    const secondLlm = new FakeLlmClient([action('fill', ['f2', '小雨点']), done()])

    const [first, second] = await Promise.all([
      execute(device(), firstArtifacts, firstBridge, firstLlm),
      execute(device('ipad-820x1180', 820, 1180), secondArtifacts, secondBridge, secondLlm),
    ])

    assert.notEqual(firstBridge.openCalls[0]?.session, secondBridge.openCalls[0]?.session)
    assert.equal(first.steps[1]?.command, 'click')
    assert.equal(second.steps[1]?.command, 'fill')
    assert.equal(firstLlm.reports.length, 1)
    assert.equal(secondLlm.reports.length, 1)
  })
})

test('reports failed actions to the same device Agent so it can recover', async () => {
  await withArtifacts(async (artifacts) => {
    const bridge = new FakeCliBridge()
    bridge.failCommand = 'click'
    const llm = new FakeLlmClient([action('click', ['f1']), action('press', ['Enter']), done()])
    const run = await execute(device(), artifacts, bridge, llm)

    assert.equal(run.status, 'completed')
    assert.equal(run.steps[1]?.status, 'failed')
    assert.equal(run.steps[2]?.status, 'success')
    assert.equal(llm.reports[0]?.ok, false)
    assert.equal(llm.reports[1]?.ok, true)
  })
})

test('retries temporary gateway throttling without sharing another device conversation', async () => {
  await withArtifacts(async (artifacts) => {
    const bridge = new FakeCliBridge()
    const llm = new FakeLlmClient([done()], 2)
    const run = await execute(device(), artifacts, bridge, llm, { gatewayRetryDelayMs: 0 })

    assert.equal(llm.nextActionCalls, 3)
    assert.equal(run.status, 'completed')
  })
})

test('a device that reaches max turns fails but still keeps diagnostic evidence', async () => {
  await withArtifacts(async (artifacts) => {
    const bridge = new FakeCliBridge()
    const llm = new FakeLlmClient([action('click', ['f1'])])
    const run = await execute(device(), artifacts, bridge, llm, { maxTurns: 1 })

    assert.equal(run.status, 'failed')
    assert.match(run.error ?? '', /最大轮数/)
    assert.ok(run.finalScreenshotUrl)
    assert.equal(bridge.closeCalls.length, 1)
  })
})

test('does not open a queued device after its Agent batch is cancelled', async () => {
  await withArtifacts(async (artifacts) => {
    const bridge = new FakeCliBridge()
    const run = await execute(device(), artifacts, bridge, new FakeLlmClient([done()]), {
      isCancelled: () => true,
    })

    assert.equal(run.status, 'cancelled')
    assert.equal(bridge.openCalls.length, 0)
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

async function execute(
  target: ScreenshotDevicePresetSnapshot,
  artifacts: DeviceAgentArtifacts,
  bridge: FakeCliBridge,
  llm: FakeLlmClient,
  overrides: Partial<Parameters<typeof runDeviceAgent>[0]> = {},
) {
  return runDeviceAgent({
    device: target,
    artifacts,
    url: 'https://example.com',
    task: '测试任务',
    maxTurns: 5,
    runId: 'test-run',
    gatewayConfig: null,
    cliBridge: bridge,
    screenshotDelayMs: 0,
    gatewayRetryDelayMs: 0,
    onDeviceStatus: () => undefined,
    onDeviceStep: () => undefined,
    createLlmClient: () => llm,
    ...overrides,
  })
}

async function withArtifacts(
  runCase: (artifacts: DeviceAgentArtifacts, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'viewport-lab-device-agent-'))
  try {
    await runCase(await createArtifacts(root, 'iphone-390x844'), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function createArtifacts(root: string, id: string): Promise<DeviceAgentArtifacts> {
  const deviceDir = join(root, id)
  const screenshotsDir = join(deviceDir, 'steps')
  const snapshotsDir = join(deviceDir, 'snapshots')
  await mkdir(screenshotsDir, { recursive: true })
  await mkdir(snapshotsDir, { recursive: true })
  return {
    screenshotsDir,
    snapshotsDir,
    specDir: deviceDir,
    finalScreenshotPath: join(root, `${id}.png`),
  }
}
