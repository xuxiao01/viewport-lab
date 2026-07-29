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
        maxTurns: 5,
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
