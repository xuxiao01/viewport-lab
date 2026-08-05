import assert from 'node:assert/strict'
import test from 'node:test'

import { parseTaskPromptOptimizationCompletion } from './task-prompt-optimizer.js'

function completionWithArguments(argumentsValue: unknown): unknown {
  return {
    choices: [
      {
        message: {
          tool_calls: [
            {
              function: {
                name: 'return_task_prompt_optimization',
                arguments: JSON.stringify(argumentsValue),
              },
            },
          ],
        },
      },
    ],
  }
}

test('parses structured clarification questions for a task prompt', () => {
  const result = parseTaskPromptOptimizationCompletion(
    completionWithArguments({
      needsClarification: true,
      optimizedTask: '',
      questions: [
        {
          id: 'q1',
          question: '应该在什么时机截图？',
          options: [
            { id: 'a', label: '第一个弹窗出现时' },
            { id: 'b', label: '课程完成后' },
          ],
        },
      ],
    }),
    false,
  )

  assert.deepEqual(result, {
    status: 'needs_clarification',
    questions: [
      {
        id: 'q1',
        question: '应该在什么时机截图？',
        options: [
          { id: 'a', label: '第一个弹窗出现时' },
          { id: 'b', label: '课程完成后' },
        ],
      },
    ],
  })
})

test('parses a ready optimized task and rejects a second clarification round', () => {
  const ready = completionWithArguments({
    needsClarification: false,
    questions: [],
    optimizedTask: '目标：进入课程后，在第一个弹窗出现时截图。',
  })
  assert.deepEqual(parseTaskPromptOptimizationCompletion(ready, true), {
    status: 'ready',
    optimizedTask: '目标：进入课程后，在第一个弹窗出现时截图。',
  })

  assert.throws(
    () =>
      parseTaskPromptOptimizationCompletion(
        completionWithArguments({
          needsClarification: true,
          optimizedTask: '',
          questions: [
            {
              id: 'q1',
              question: '是否继续？',
              options: [
                { id: 'a', label: '是' },
                { id: 'b', label: '否' },
              ],
            },
          ],
        }),
        true,
      ),
    /澄清答案生成最终任务描述/,
  )
})

test('rejects malformed or unstructured optimizer responses', () => {
  assert.throws(
    () => parseTaskPromptOptimizationCompletion({ choices: [] }, false),
    /未按约定返回任务优化结果/,
  )
  assert.throws(
    () =>
      parseTaskPromptOptimizationCompletion(
        completionWithArguments({
          needsClarification: true,
          optimizedTask: '',
          questions: [
            {
              id: 'q1',
              question: '只有一个选项是否可以？',
              options: [{ id: 'a', label: '不可以' }],
            },
          ],
        }),
        false,
      ),
    /澄清问题格式无效/,
  )
})
