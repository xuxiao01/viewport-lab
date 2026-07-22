import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { AgentConfidenceLevel } from '@viewport-lab/shared'

const rootDir = fileURLToPath(new URL('.', import.meta.url))
const promptsFile = resolve(rootDir, 'prompts.md')

const raw = readFileSync(promptsFile, 'utf8')

interface PromptSections {
  SYSTEM: string
  TASK: string
  CONTINUE: string
}

function parseSections(content: string): PromptSections {
  const sections: Record<string, string> = {}
  const parts = content.split(/^## \[(\w+)\]\s*$/m)
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i]
    const body = parts[i + 1]
    if (name && body !== undefined) {
      sections[name] = body.trim()
    }
  }
  return sections as unknown as PromptSections
}

const sections = parseSections(raw)

export const CONFIDENCE_LEVELS: AgentConfidenceLevel[] = ['high', 'medium', 'low']

const INFO_SCHEMA = `{
  "step": string,          // 当前步骤的简短标识
  "intent": string,        // 本步骤的目的
  "observation": string,   // 执行后观察到的页面状态变化
  "confidence": "high" | "medium" | "low",
  "issues": string[]       // 发现的问题或风险
}`

export const SYSTEM_PROMPT = sections.SYSTEM.replace('${INFO_SCHEMA}', INFO_SCHEMA)

const ALLOWED_CLI_COMMANDS = [
  'goto',
  'go-back',
  'go-forward',
  'reload',
  'click',
  'dblclick',
  'fill',
  'press',
  'hover',
  'select',
  'check',
  'uncheck',
  'snapshot',
  'find',
  'eval',
] as const

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'run_cli',
      description:
        '执行一个 Playwright CLI 浏览器命令。系统会在命令完成后自动截图（snapshot 命令除外）。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            enum: ALLOWED_CLI_COMMANDS,
            description: 'CLI 命令名',
          },
          args: {
            type: 'array',
            items: { type: 'string' },
            description: 'CLI 位置参数，如 ["f1e25"] 或 ["f1e25", "搜索文本"]。goto 命令传 URL。',
          },
          purpose: {
            type: 'string',
            description: '本次调用对完成用户任务的作用。',
          },
          info: {
            type: 'object',
            description: '本步骤的结构化信息，用于前端展示和报告生成。',
            properties: {
              step: { type: 'string', description: '当前步骤的简短标识' },
              intent: { type: 'string', description: '本步骤的目的' },
              observation: {
                type: 'string',
                description: '执行后观察到的页面状态变化',
              },
              confidence: {
                type: 'string',
                enum: CONFIDENCE_LEVELS,
                description: '对当前步骤的信心程度',
              },
              issues: {
                type: 'array',
                items: { type: 'string' },
                description: '发现的问题或风险',
              },
            },
            required: ['step', 'intent', 'observation', 'confidence', 'issues'],
            additionalProperties: false,
          },
        },
        required: ['command', 'args', 'purpose', 'info'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: '任务完成时调用。通过 summary 参数输出最终摘要。',
      parameters: {
        type: 'object',
        properties: {
          summary: {
            type: 'object',
            description: '任务最终摘要',
            properties: {
              step: { type: 'string', description: '最终步骤标识' },
              intent: { type: 'string', description: '整体任务完成情况' },
              observation: { type: 'string', description: '最终页面状态和结论' },
              confidence: {
                type: 'string',
                enum: CONFIDENCE_LEVELS,
                description: '对任务完成质量的信心',
              },
              issues: {
                type: 'array',
                items: { type: 'string' },
                description: '遗留问题或建议',
              },
            },
            required: ['step', 'intent', 'observation', 'confidence', 'issues'],
            additionalProperties: false,
          },
        },
        required: ['summary'],
        additionalProperties: false,
      },
    },
  },
]

export function buildTaskPrompt(
  deviceLabel: string,
  task: string,
  url: string,
  initialSnapshot: string,
): string {
  return sections.TASK.replace('${deviceLabel}', deviceLabel)
    .replace('${url}', url)
    .replace('${task}', task)
    .replace('${initialSnapshot}', initialSnapshot)
}

export function buildContinuePrompt(): string {
  return sections.CONTINUE
}
