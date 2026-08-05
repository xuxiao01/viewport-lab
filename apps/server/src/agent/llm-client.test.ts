import assert from 'node:assert/strict'
import test from 'node:test'

import type { ScreenshotDevicePresetSnapshot } from '@viewport-lab/shared'
import type OpenAI from 'openai'

import type { AgentGatewayConfig } from './config.js'
import type { ActionResultReport } from './llm-client.js'
import { classifyGatewayError, RealDeviceLlmClient } from './llm-client.js'

test('gateway retry reuses the frozen request and includes the full task only once', async () => {
  const requests: unknown[] = []
  let attempt = 0
  const client = {
    chat: {
      completions: {
        create: async (request: unknown) => {
          requests.push(structuredClone(request))
          attempt += 1
          if (attempt === 1) throw new Error('429 Too Many Requests: QPS limit')
          return completion('call-1', 'click', ['f1'])
        },
      },
    },
  } as unknown as OpenAI
  const llm = new RealDeviceLlmClient(config(), device(), 'https://example.com', 'snapshot', '唯一任务描述', client)

  await assert.rejects(() => llm.nextAction(), /Too Many Requests/)
  const result = await llm.retryNextAction()

  assert.equal(result.command, 'click')
  assert.deepEqual(requests[1], requests[0])
  assert.equal(JSON.stringify(requests[0]).match(/唯一任务描述/g)?.length, 1)
})

test('classifies quota 429 as terminal and explicit QPS or 5xx errors as retryable', () => {
  assert.deepEqual(
    classifyGatewayError(new Error('429 You exceeded your current quota. billing details token-limit')),
    { retryable: false, retryAfterMs: null },
  )
  assert.equal(classifyGatewayError(new Error('429 Too Many Requests: QPS rate limit')).retryable, true)
  assert.equal(classifyGatewayError(new Error('503 Service Unavailable')).retryable, true)
  assert.equal(classifyGatewayError(new Error('429 request rejected')).retryable, false)
})

test('keeps only ten complete rounds and compacts older tool results into a deterministic summary', async () => {
  const requests: CapturedRequest[] = []
  let requestNumber = 0
  const client = recordingClient(requests, () => {
    requestNumber += 1
    return completion(`call-${requestNumber}`, 'click', [`marker-${requestNumber}`], {
      purpose: `执行第 ${requestNumber} 步`,
      observation: `已到达流程 ${requestNumber}`,
    })
  })
  const llm = new RealDeviceLlmClient(
    config(),
    device(),
    'https://example.com',
    'initial-snapshot',
    '长流程唯一任务',
    client,
  )

  for (let round = 1; round <= 25; round++) {
    await llm.nextAction()
    llm.reportResult(report(round))
  }
  await llm.nextAction()

  const messages = lastRequestMessages(requests)
  const summary = historySummary(messages)
  assert.equal(messages.filter((message) => message.role === 'assistant').length, 10)
  assert.equal(messages.filter((message) => message.role === 'tool').length, 10)
  assert.match(summary, /已压缩 15 个完整轮次/)
  assert.match(summary, /marker-1/)
  assert.match(summary, /marker-15/)
  assert.match(summary, /snapshotSha256=hash-15/)
  assert.doesNotMatch(JSON.stringify(messages), /full-snapshot-1(?:\D|$)/)
  assert.match(JSON.stringify(messages), /full-snapshot-16/)
  assert.equal(JSON.stringify(messages).match(/长流程唯一任务/g)?.length, 1)
  assertToolRoundsAreComplete(messages)
})

test('keeps request message count stable through one hundred rounds and bounds the summary', async () => {
  const requests: CapturedRequest[] = []
  let requestNumber = 0
  const client = recordingClient(requests, () => {
    requestNumber += 1
    return completion(`call-${requestNumber}`, 'fill', [`f${requestNumber}`, `输入-${requestNumber}`], {
      purpose: `填写流程字段 ${requestNumber} ${'x'.repeat(180)}`,
      observation: `当前阶段 ${requestNumber} ${'y'.repeat(220)}`,
    })
  })
  const llm = new RealDeviceLlmClient(
    config(),
    device(),
    'https://example.com',
    'initial-snapshot',
    '百轮稳定性任务',
    client,
  )

  for (let round = 1; round <= 100; round++) {
    await llm.nextAction()
    llm.reportResult(report(round, round % 17 !== 0))
  }
  await llm.nextAction()

  const messages = lastRequestMessages(requests)
  const summary = historySummary(messages)
  assert.equal(messages.length, 34)
  assert.equal(messages.filter((message) => message.role === 'assistant').length, 10)
  assert.equal(messages.filter((message) => message.role === 'tool').length, 10)
  assert.ok(summary.length <= 12_000)
  assert.match(summary, /已压缩 90 个完整轮次/)
  assert.match(summary, /Page 90/)
  assert.match(summary, /文件上传=default-photo\.png\/uploaded/)
  assertToolRoundsAreComplete(messages)
})

function completion(
  id: string,
  command: string,
  args: string[],
  details: { purpose?: string; observation?: string } = {},
) {
  return {
    id: 'completion-1',
    object: 'chat.completion',
    created: 0,
    model: 'deepseek-v4-flash-0731',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        logprobs: null,
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          tool_calls: [
            {
              id,
              type: 'function',
              function: {
                name: 'run_cli',
                arguments: JSON.stringify({
                  command,
                  args,
                  purpose: details.purpose ?? '测试',
                  info: {
                    step: command,
                    intent: details.purpose ?? '测试',
                    observation: details.observation ?? '',
                    confidence: 'high',
                    issues: [],
                  },
                }),
              },
            },
          ],
        },
      },
    ],
  }
}

interface CapturedMessage {
  role: string
  content?: unknown
  tool_calls?: unknown
}

interface CapturedRequest {
  messages: CapturedMessage[]
}

function recordingClient(
  requests: CapturedRequest[],
  nextCompletion: () => ReturnType<typeof completion>,
): OpenAI {
  return {
    chat: {
      completions: {
        create: async (request: unknown) => {
          requests.push(structuredClone(request) as CapturedRequest)
          return nextCompletion()
        },
      },
    },
  } as unknown as OpenAI
}

function report(round: number, ok = true): ActionResultReport {
  return {
    ok,
    error: ok ? null : `第 ${round} 步执行失败`,
    command: round > 25 ? 'fill' : 'click',
    output: ok ? `output-${round}` : '',
    wait: null,
    page: { url: `https://example.com/step/${round}`, title: `Page ${round}` },
    snapshot: `full-snapshot-${round}`,
    snapshotMeta: {
      snapshotRef: `snapshot:run:device:hash-${round}`,
      changed: true,
      truncated: false,
      originalChars: 20,
      returnedChars: 20,
      sameAsStepIndex: null,
      sha256: `hash-${round}`,
    },
    screenshotUrl: `/step-${round}.png`,
    dialog: null,
    blockedModal: null,
    fileUpload:
      round === 30
        ? { fileName: 'default-photo.png', status: 'uploaded', error: null }
        : null,
  }
}

function lastRequestMessages(requests: CapturedRequest[]): CapturedMessage[] {
  const request = requests.at(-1)
  assert.ok(request)
  return request.messages
}

function historySummary(messages: CapturedMessage[]): string {
  const summary = messages.find(
    (message) =>
      message.role === 'user' &&
      typeof message.content === 'string' &&
      message.content.startsWith('[Agent 历史执行摘要'),
  )?.content
  if (typeof summary !== 'string') throw new Error('未找到 Agent 历史执行摘要')
  return summary
}

function assertToolRoundsAreComplete(messages: CapturedMessage[]): void {
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.role !== 'assistant') continue
    assert.equal(messages[index + 1]?.role, 'tool')
  }
}

function config(): AgentGatewayConfig {
  return {
    apiUrl: 'http://gateway.example/v1',
    apiKey: 'test-key',
    vhost: 'test.example',
    model: 'deepseek-v4-flash-0731',
    timeoutMs: 1_000,
  }
}

function device(): ScreenshotDevicePresetSnapshot {
  return {
    selectionId: 'iphone-390x844',
    platformId: 'ios-phone',
    platformName: '苹果手机',
    presetId: 'iphone-390x844',
    presetName: '390 × 844',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    fullPage: false,
    readySelector: '',
    captureDelayMs: 0,
  }
}
