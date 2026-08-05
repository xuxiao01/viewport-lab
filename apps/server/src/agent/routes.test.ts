import assert from 'node:assert/strict'
import test from 'node:test'

import Fastify from 'fastify'

import { registerAgentRoutes } from './routes.js'

test('rejects malformed Agent device snapshots before creating a run', async () => {
  const app = Fastify()
  await registerAgentRoutes(app)

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agent/runs',
      payload: {
        url: 'https://example.com',
        task: '检查页面',
        note: '',
        maxTurns: 150,
        devices: [
          {
            selectionId: '../outside',
            platformId: 'ios-phone',
            platformName: '苹果手机',
            presetId: 'iphone-390x844',
            presetName: 'iPhone',
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
            fullPage: false,
            readySelector: '',
            captureDelayMs: 0,
          },
        ],
      },
    })

    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { error: 'Invalid agent run request' })
  } finally {
    await app.close()
  }
})

test('rejects Agent models outside the supported model list', async () => {
  const app = Fastify()
  await registerAgentRoutes(app)

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/agent/runs',
      payload: {
        url: 'https://example.com',
        task: '检查页面',
        note: '',
        maxTurns: 150,
        model: 'unsupported-model',
        devices: [
          {
            selectionId: 'ios-phone:iphone-390x844',
            platformId: 'ios-phone',
            platformName: '苹果手机',
            presetId: 'iphone-390x844',
            presetName: 'iPhone',
            viewport: { width: 390, height: 844 },
            deviceScaleFactor: 3,
            isMobile: true,
            hasTouch: true,
            fullPage: false,
            readySelector: '',
            captureDelayMs: 0,
          },
        ],
      },
    })

    assert.equal(response.statusCode, 400)
    assert.deepEqual(response.json(), { error: 'Invalid agent run request' })
  } finally {
    await app.close()
  }
})

test('rejects Agent max turns outside the 100 to 200 range', async () => {
  const app = Fastify()
  await registerAgentRoutes(app)
  const device = {
    selectionId: 'ios-phone:iphone-390x844',
    platformId: 'ios-phone',
    platformName: '苹果手机',
    presetId: 'iphone-390x844',
    presetName: 'iPhone',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    fullPage: false,
    readySelector: '',
    captureDelayMs: 0,
  }

  try {
    for (const maxTurns of [99, 201]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/agent/runs',
        payload: {
          url: 'https://example.com',
          task: '检查页面',
          note: '',
          maxTurns,
          devices: [device],
        },
      })

      assert.equal(response.statusCode, 400)
      assert.deepEqual(response.json(), { error: 'Invalid agent run request' })
    }
  } finally {
    await app.close()
  }
})

test('rejects malformed task prompt optimization requests without creating an Agent run', async () => {
  const app = Fastify()
  await registerAgentRoutes(app)

  try {
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/agent/task-prompt-optimizer',
      payload: {
        url: 'https://example.com',
        note: '',
        task: '   ',
        model: 'deepseek-v4-flash-0731',
        clarifications: [],
      },
    })
    assert.equal(invalid.statusCode, 400)
    assert.deepEqual(invalid.json(), { error: 'Invalid task prompt optimization request' })

    const unsupportedModel = await app.inject({
      method: 'POST',
      url: '/api/agent/task-prompt-optimizer',
      payload: {
        url: 'https://example.com',
        note: '',
        task: '检查首页',
        model: 'unsupported-model',
        clarifications: [],
      },
    })
    assert.equal(unsupportedModel.statusCode, 400)
  } finally {
    await app.close()
  }
})

test('validates Agent task title updates before reading the run', async () => {
  const app = Fastify()
  await registerAgentRoutes(app)

  try {
    const invalid = await app.inject({
      method: 'PATCH',
      url: '/api/agent/runs/2026-07-29_10-00-00-000_deadbeef',
      payload: { note: 'x'.repeat(201) },
    })
    assert.equal(invalid.statusCode, 400)

    const missing = await app.inject({
      method: 'PATCH',
      url: '/api/agent/runs/2026-07-29_10-00-00-000_deadbeef',
      payload: { note: '  新标题  ' },
    })
    assert.equal(missing.statusCode, 404)
  } finally {
    await app.close()
  }
})
