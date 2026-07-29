import assert from 'node:assert/strict'
import test from 'node:test'

import { ConcurrencyScheduler, SerialBatchScheduler } from './task-scheduler.js'

test('ConcurrencyScheduler runs at most the configured number of tasks', async () => {
  const scheduler = new ConcurrencyScheduler(3)
  const releases: Array<() => void> = []
  let active = 0
  let peak = 0
  let completed = 0

  for (let index = 0; index < 5; index++) {
    scheduler.enqueue(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => releases.push(resolve))
      active -= 1
      completed += 1
    })
  }

  await waitFor(() => releases.length === 3)
  assert.equal(peak, 3)
  assert.equal(scheduler.pending, 2)
  releases.shift()?.()
  await waitFor(() => releases.length === 3)
  while (completed < 5) {
    while (releases.length) releases.shift()?.()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await waitFor(() => completed === 5)
  assert.equal(peak, 3)
})

test('SerialBatchScheduler keeps batches serial while running one batch tasks together', async () => {
  const scheduler = new SerialBatchScheduler()
  const events: string[] = []
  const firstReleases: Array<() => void> = []

  for (let index = 0; index < 2; index++) {
    scheduler.enqueue('batch-a', 2, async () => {
      events.push(`a${index}:start`)
      await new Promise<void>((resolve) => firstReleases.push(resolve))
      events.push(`a${index}:end`)
    })
  }
  scheduler.enqueue('batch-b', 1, async () => {
    events.push('b:start')
    events.push('b:end')
  })

  await waitFor(() => firstReleases.length === 2)
  assert.equal(events.includes('b:start'), false)
  firstReleases.forEach((release) => release())
  await waitFor(() => events.includes('b:end'))
  assert.deepEqual(events.slice(0, 2).sort(), ['a0:start', 'a1:start'])
})

test('ConcurrencyScheduler releases a slot after a task fails', async () => {
  const scheduler = new ConcurrencyScheduler(1)
  let nextTaskStarted = false

  scheduler.enqueue(async () => {
    throw new Error('expected failure')
  })
  scheduler.enqueue(async () => {
    nextTaskStarted = true
  })

  await waitFor(() => nextTaskStarted && scheduler.active === 0)
  assert.equal(scheduler.active, 0)
  assert.equal(scheduler.pending, 0)
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('等待调度器状态超时')
}
