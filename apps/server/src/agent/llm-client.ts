import type { AgentStepInfo, ScreenshotDevicePresetSnapshot } from '@viewport-lab/shared'
import http from 'node:http'
import OpenAI from 'openai'
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions.js'

import type { AgentGatewayConfig } from './config.js'
import {
  buildContinuePrompt,
  buildTaskPrompt,
  SYSTEM_PROMPT,
  TOOL_DEFINITIONS,
} from './prompts.js'

function createGatewayFetch(vhost: string): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.toString())
    const body = init?.body
    const bodyStr =
      typeof body === 'string' ? body : body && typeof body === 'object' ? JSON.stringify(body) : ''

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Host: vhost,
      'Content-Length': String(Buffer.byteLength(bodyStr)),
    }
    if (init?.headers) {
      const initHeaders = init.headers
      if (initHeaders instanceof Headers) {
        initHeaders.forEach((value, key) => {
          if (key.toLowerCase() !== 'host') headers[key] = value
        })
      } else if (Array.isArray(initHeaders)) {
        for (const [key, value] of initHeaders) {
          if (key.toLowerCase() !== 'host') headers[key] = value
        }
      } else if (typeof initHeaders === 'object') {
        for (const [key, value] of Object.entries(initHeaders)) {
          if (key.toLowerCase() !== 'host') headers[key] = String(value)
        }
      }
    }

    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          method: init?.method ?? 'POST',
          hostname: url.hostname,
          port: url.port || 80,
          path: url.pathname + url.search,
          headers,
        },
        (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            data += chunk
          })
          res.on('end', () => {
            resolve(
              new Response(data, {
                status: res.statusCode ?? 500,
                headers: res.headers as Record<string, string>,
              }),
            )
          })
        },
      )
      req.on('error', reject)
      req.write(bodyStr)
      req.end()
    })
  }
}

export interface NextActionResult {
  command: string | null
  args: string[]
  purpose: string
  info: AgentStepInfo | null
  done: boolean
  summary: AgentStepInfo | null
}

export interface ActionResultReport {
  ok: boolean
  error: string | null
  output: string
  screenshotUrl: string | null
}

export interface DeviceLlmClient {
  nextAction(): Promise<NextActionResult>
  reportResult(report: ActionResultReport): void
  close(): void
}

export function createDeviceLlmClient(
  config: AgentGatewayConfig | null,
  device: ScreenshotDevicePresetSnapshot,
  initialUrl: string,
  initialSnapshot: string,
  task: string,
): DeviceLlmClient {
  if (!config) {
    return new StubDeviceLlmClient(device, initialUrl)
  }
  return new RealDeviceLlmClient(config, device, initialUrl, initialSnapshot, task)
}

class RealDeviceLlmClient implements DeviceLlmClient {
  private readonly client: OpenAI
  private readonly messages: ChatCompletionMessageParam[] = []
  private pendingToolCallId: string | null = null
  private readonly model: string
  private readonly timeoutMs: number
  private readonly task: string

  constructor(
    config: AgentGatewayConfig,
    device: ScreenshotDevicePresetSnapshot,
    initialUrl: string,
    initialSnapshot: string,
    task: string,
  ) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.apiUrl,
      fetch: createGatewayFetch(config.vhost),
      timeout: config.timeoutMs,
    })
    this.model = config.model
    this.timeoutMs = config.timeoutMs
    this.task = task

    const deviceLabel = `${device.platformName} ${device.presetName} (${device.viewport.width}×${device.viewport.height})`

    this.messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildTaskPrompt(deviceLabel, task, initialUrl, initialSnapshot) },
    ]
  }

  async nextAction(): Promise<NextActionResult> {
    this.messages.push({
      role: 'user',
      content: this.task
        ? `用户任务：${this.task}\n${buildContinuePrompt()}`
        : buildContinuePrompt(),
    })

    let completion: ChatCompletion
    try {
      const result = await this.client.chat.completions.create({
        model: this.model,
        messages: this.messages,
        tools: TOOL_DEFINITIONS,
        tool_choice: 'auto',
        temperature: 0,
        stream: false,
        enable_thinking: false,
      } as Parameters<typeof this.client.chat.completions.create>[0])
      completion = result as ChatCompletion
    } catch (error) {
      throw new Error(`AI 网关调用失败：${error instanceof Error ? error.message : String(error)}`)
    }

    const choices = completion.choices
    if (!choices || choices.length === 0) {
      return { command: null, args: [], purpose: '', info: null, done: true, summary: null }
    }
    const msg = choices[0]?.message
    if (!msg) {
      return { command: null, args: [], purpose: '', info: null, done: true, summary: null }
    }

    this.messages.push(msg as ChatCompletionMessageParam)

    const toolCalls = msg.tool_calls
    if (toolCalls && toolCalls.length > 0) {
      const toolCall = toolCalls[0]
      if (!toolCall) {
        return { command: null, args: [], purpose: '', info: null, done: true, summary: null }
      }
      this.pendingToolCallId = toolCall.id
      return this.parseToolCall(
        toolCall as { id: string; function: { name: string; arguments: string } },
      )
    }

    const content = msg.content ?? ''
    return {
      command: null,
      args: [],
      purpose: '',
      info: null,
      done: true,
      summary: {
        step: 'text-response',
        intent: '模型返回文本回复，未调用工具',
        observation: content.slice(0, 500),
        confidence: 'low',
        issues: ['模型未调用 finish 工具，直接返回文本'],
      },
    }
  }

  reportResult(report: ActionResultReport): void {
    if (!this.pendingToolCallId) return
    this.messages.push({
      role: 'tool',
      tool_call_id: this.pendingToolCallId,
      content: JSON.stringify({
        ok: report.ok,
        error: report.error,
        output: report.output.slice(0, 4000),
        screenshotUrl: report.screenshotUrl,
      }),
    })
    this.pendingToolCallId = null
  }

  close(): void {
    // OpenAI SDK 在 Node 端无需显式关闭
  }

  private parseToolCall(toolCall: {
    id: string
    function: { name: string; arguments: string }
  }): NextActionResult {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(toolCall.function.arguments) as Record<string, unknown>
    } catch {
      return {
        command: null,
        args: [],
        purpose: '',
        info: {
          step: 'parse-error',
          intent: '解析工具调用参数失败',
          observation: toolCall.function.arguments,
          confidence: 'low',
          issues: ['LLM 返回的工具调用参数不是合法 JSON'],
        },
        done: true,
        summary: null,
      }
    }

    if (toolCall.function.name === 'finish') {
      const summary = parsed.summary as AgentStepInfo | undefined
      return {
        command: null,
        args: [],
        purpose: '',
        info: null,
        done: true,
        summary: summary ?? {
          step: 'finish',
          intent: '任务完成',
          observation: String(parsed.summary ?? ''),
          confidence: 'low',
          issues: [],
        },
      }
    }

    if (toolCall.function.name !== 'run_cli') {
      return {
        command: null,
        args: [],
        purpose: '',
        info: {
          step: 'unknown-tool',
          intent: `未知工具：${toolCall.function.name}`,
          observation: '',
          confidence: 'low',
          issues: [`LLM 调用了未知工具 ${toolCall.function.name}`],
        },
        done: true,
        summary: null,
      }
    }

    const command = typeof parsed.command === 'string' ? parsed.command : null
    const args = Array.isArray(parsed.args) ? (parsed.args as string[]).map(String) : []
    const purpose = typeof parsed.purpose === 'string' ? parsed.purpose : ''
    const info = (parsed.info as AgentStepInfo | undefined) ?? null

    if (!command) {
      return {
        command: null,
        args: [],
        purpose: '',
        info: {
          step: 'invalid-action',
          intent: '无效的命令请求',
          observation: JSON.stringify(parsed),
          confidence: 'low',
          issues: ['LLM 未返回有效的 command'],
        },
        done: true,
        summary: null,
      }
    }

    return { command, args, purpose, info, done: false, summary: null }
  }
}

class StubDeviceLlmClient implements DeviceLlmClient {
  private turnCount = 0

  constructor(
    private readonly device: ScreenshotDevicePresetSnapshot,
    private readonly initialUrl: string,
  ) {}

  async nextAction(): Promise<NextActionResult> {
    this.turnCount++
    if (this.turnCount === 1) {
      return {
        command: 'goto',
        args: [this.initialUrl],
        purpose: '打开目标页面',
        info: {
          step: 'goto',
          intent: '打开目标页面',
          observation: '页面已加载',
          confidence: 'low',
          issues: ['网关未配置，stub 模式'],
        },
        done: false,
        summary: null,
      }
    }
    return {
      command: null,
      args: [],
      purpose: '',
      info: null,
      done: true,
      summary: {
        step: 'stub-complete',
        intent: 'stub 完成示例任务',
        observation: '网关未配置，仅验证 CLI 管线',
        confidence: 'low',
        issues: ['LLM 网关未配置'],
      },
    }
  }

  reportResult(): void {
    // no-op
  }

  close(): void {
    // no-op
  }
}
