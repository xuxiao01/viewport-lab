import type {
  ChatCompletion,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions.js'
import type {
  OptimizeAgentTaskPromptRequest,
  OptimizeAgentTaskPromptResult,
  TaskPromptClarificationOption,
  TaskPromptClarificationQuestion,
} from '@viewport-lab/shared'
import { taskPromptOptimizationLimits } from '@viewport-lab/shared'

import type { AgentGatewayConfig } from './config.js'
import { createGatewayOpenAIClient } from './gateway-client.js'

const optimizerToolName = 'return_task_prompt_optimization'
const identifierPattern = /^[a-z][a-z0-9_-]{0,31}$/

const OPTIMIZER_SYSTEM_PROMPT = `你是网页测试任务描述的澄清和改写助手。你不会访问网页、不会调用浏览器、不会执行任务。

你的输入只有用户提供的 URL、任务标题、原始任务描述，以及可能的用户澄清答案。不能假设页面上存在任何元素、接口或业务流程。

首次分析时，仅当缺少会明显改变操作路径的关键信息，才提出问题；最多 3 个。问题只能聚焦：截图时机或完成判定、随机题/随机页面的处理方式、是否允许提交/完成/领取等有业务副作用的操作。每题提供 2 到 4 个互斥选项，使用稳定 id（q1、q2、q3；a、b、c、d）。不要询问设备、视口、模型或技术实现细节。

若信息足够，或已提供澄清答案，输出优化后的中文任务描述。描述应清楚写出目标、完成判定、操作规则、截图时机和限制；不要编造用户没有说过的页面元素或业务操作，也不要要求 API Key、账号、隐私信息或任何页面访问。

必须调用指定函数返回结构化结果，不能返回普通文本。`

const optimizerTool = {
  type: 'function' as const,
  function: {
    name: optimizerToolName,
    description: '返回任务描述澄清问题或优化后的任务描述。',
    parameters: {
      type: 'object',
      properties: {
        needsClarification: { type: 'boolean' },
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              question: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    label: { type: 'string' },
                  },
                  required: ['id', 'label'],
                  additionalProperties: false,
                },
              },
            },
            required: ['id', 'question', 'options'],
            additionalProperties: false,
          },
        },
        optimizedTask: { type: 'string' },
      },
      required: ['needsClarification', 'questions', 'optimizedTask'],
      additionalProperties: false,
    },
  },
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseOption(value: unknown): TaskPromptClarificationOption | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string') return null
  const id = value.id.trim()
  const label = value.label.trim()
  if (!identifierPattern.test(id) || label.length === 0 || label.length > taskPromptOptimizationLimits.clarificationTextMaxLength) {
    return null
  }
  return { id, label }
}

function parseQuestion(value: unknown): TaskPromptClarificationQuestion | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.question !== 'string') return null
  if (!Array.isArray(value.options)) return null
  const id = value.id.trim()
  const question = value.question.trim()
  if (!identifierPattern.test(id) || question.length === 0 || question.length > taskPromptOptimizationLimits.clarificationTextMaxLength) {
    return null
  }
  if (value.options.length < 2 || value.options.length > taskPromptOptimizationLimits.optionMaxCount) {
    return null
  }
  const options = value.options.map(parseOption)
  if (options.some((option) => option === null)) return null
  const validOptions = options.filter((option): option is TaskPromptClarificationOption => option !== null)
  if (new Set(validOptions.map((option) => option.id)).size !== validOptions.length) return null
  return { id, question, options: validOptions }
}

function extractToolArguments(completion: unknown): unknown {
  if (!isRecord(completion) || !Array.isArray(completion.choices)) return null
  const message = completion.choices[0]
  if (!isRecord(message) || !isRecord(message.message) || !Array.isArray(message.message.tool_calls)) {
    return null
  }
  const toolCall = message.message.tool_calls[0]
  if (!isRecord(toolCall) || !isRecord(toolCall.function) || toolCall.function.name !== optimizerToolName) {
    return null
  }
  if (typeof toolCall.function.arguments !== 'string') return null
  try {
    return JSON.parse(toolCall.function.arguments) as unknown
  } catch {
    return null
  }
}

export function parseTaskPromptOptimizationCompletion(
  completion: unknown,
  finalizing: boolean,
): OptimizeAgentTaskPromptResult {
  const parsed = extractToolArguments(completion)
  if (!isRecord(parsed) || typeof parsed.needsClarification !== 'boolean' || !Array.isArray(parsed.questions) || typeof parsed.optimizedTask !== 'string') {
    throw new Error('AI 未按约定返回任务优化结果')
  }

  if (parsed.needsClarification) {
    if (finalizing) throw new Error('AI 未根据已提供的澄清答案生成最终任务描述')
    if (parsed.questions.length === 0 || parsed.questions.length > taskPromptOptimizationLimits.clarificationMaxCount) {
      throw new Error('AI 返回的澄清问题数量无效')
    }
    const questions = parsed.questions.map(parseQuestion)
    if (questions.some((question) => question === null)) throw new Error('AI 返回的澄清问题格式无效')
    const validQuestions = questions.filter(
      (question): question is TaskPromptClarificationQuestion => question !== null,
    )
    if (new Set(validQuestions.map((question) => question.id)).size !== validQuestions.length) {
      throw new Error('AI 返回了重复的澄清问题')
    }
    return { status: 'needs_clarification', questions: validQuestions }
  }

  const optimizedTask = parsed.optimizedTask.trim()
  if (
    parsed.questions.length > 0 ||
    optimizedTask.length === 0 ||
    optimizedTask.length > taskPromptOptimizationLimits.taskMaxLength
  ) {
    throw new Error('AI 返回的优化任务描述无效')
  }
  return { status: 'ready', optimizedTask }
}

function buildOptimizationPrompt(request: OptimizeAgentTaskPromptRequest): string {
  const hasClarifications = request.clarifications.length > 0
  return JSON.stringify(
    {
      mode: hasClarifications ? 'finalize' : 'analyze',
      url: request.url,
      taskTitle: request.note || null,
      originalTask: request.task,
      clarifications: request.clarifications,
      instruction: hasClarifications
        ? '用户已回答澄清问题。现在必须生成最终优化任务描述，needsClarification 必须为 false，questions 必须为空数组。'
        : '分析任务是否缺少关键执行条件。信息足够时直接生成优化描述；仅在关键歧义存在时返回澄清问题。',
    },
    null,
    2,
  )
}

export async function optimizeAgentTaskPrompt(
  config: AgentGatewayConfig,
  request: OptimizeAgentTaskPromptRequest,
): Promise<OptimizeAgentTaskPromptResult> {
  const client = createGatewayOpenAIClient({ ...config, model: request.model })
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: OPTIMIZER_SYSTEM_PROMPT },
    { role: 'user', content: buildOptimizationPrompt(request) },
  ]
  let completion: ChatCompletion
  try {
    completion = (await client.chat.completions.create({
      model: request.model,
      messages,
      tools: [optimizerTool],
      tool_choice: { type: 'function', function: { name: optimizerToolName } },
      temperature: 0,
      stream: false,
      enable_thinking: false,
    } as Parameters<typeof client.chat.completions.create>[0])) as ChatCompletion
  } catch (error) {
    throw new Error(`AI 网关调用失败：${error instanceof Error ? error.message : String(error)}`)
  }
  return parseTaskPromptOptimizationCompletion(completion, request.clarifications.length > 0)
}
