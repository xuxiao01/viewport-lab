import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveClientTargetUrl } from './client-target-url.js'

test('replaces localhost with the requesting client IPv4 address', () => {
  assert.equal(
    resolveClientTargetUrl('http://localhost:5188/path?q=1', '10.2.8.23'),
    'http://10.2.8.23:5188/path?q=1',
  )
})

test('normalizes IPv4-mapped client addresses', () => {
  assert.equal(
    resolveClientTargetUrl('http://127.0.0.1:3000/', '::ffff:192.168.31.45'),
    'http://192.168.31.45:3000/',
  )
})

test('supports IPv6 client addresses', () => {
  assert.equal(
    resolveClientTargetUrl('http://[::1]:4173/app', 'fd00::25'),
    'http://[fd00::25]:4173/app',
  )
})

test('leaves non-loopback targets unchanged', () => {
  assert.equal(
    resolveClientTargetUrl('https://example.test/app', '10.2.8.23'),
    'https://example.test/app',
  )
})

test('leaves localhost unchanged when the client address is unavailable', () => {
  assert.equal(
    resolveClientTargetUrl('http://localhost:5188/', 'unknown'),
    'http://localhost:5188/',
  )
})
