import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'

import type { AgentRun } from '@viewport-lab/shared'

import {
  AgentRunRecorder,
  registerActiveAgentRecorder,
  unregisterActiveAgentRecorder,
  updateAgentRunNote,
} from './recorder.js'

test('keeps an updated title when an active Agent recorder continues persisting', async () => {
  const runDir = await mkdtemp(resolve(tmpdir(), 'viewport-lab-agent-recorder-'))
  const run = createRun()
  const recorder = new AgentRunRecorder(
    { runDir, eventsPath: resolve(runDir, 'events.jsonl') },
    run,
  )
  registerActiveAgentRecorder(recorder)

  try {
    const beforeTitleUpdate = recorder.persist()
    const updated = await updateAgentRunNote(run.runId, '修改后的任务标题')
    recorder.setStatus('running')
    const afterStatusUpdate = recorder.persist()
    await Promise.all([beforeTitleUpdate, afterStatusUpdate])

    const persisted = JSON.parse(
      await readFile(resolve(runDir, 'manifest.json'), 'utf8'),
    ) as AgentRun
    assert.equal(updated?.note, '修改后的任务标题')
    assert.equal(persisted.note, '修改后的任务标题')
    assert.equal(persisted.status, 'running')
  } finally {
    unregisterActiveAgentRecorder(run.runId, recorder)
    await rm(runDir, { recursive: true, force: true })
  }
})

function createRun(): AgentRun {
  const now = new Date().toISOString()
  return {
    kind: 'agent',
    executionMode: 'leader_resize_capture',
    leaderDeviceId: null,
    runId: '2026-07-29_10-00-00-000_deadbeef',
    createdAt: now,
    updatedAt: now,
    rerunAt: null,
    completedAt: null,
    status: 'queued',
    url: 'https://example.com',
    task: '检查页面',
    note: '原标题',
    model: 'test-model',
    devices: [],
    maxTurns: 10,
    deviceRuns: [],
    rerunDeviceIds: [],
    error: null,
    durationMs: null,
  }
}
