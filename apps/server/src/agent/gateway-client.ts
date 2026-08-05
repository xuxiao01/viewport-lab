import http from 'node:http'
import { Readable } from 'node:stream'

import OpenAI from 'openai'

import type { AgentGatewayConfig } from './config.js'

export function createGatewayFetch(vhost: string): typeof fetch {
  return (input, init = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
      const headers = new Headers(init.headers)
      headers.set('Host', vhost)
      const outgoingHeaders: Record<string, string> = {}
      headers.forEach((value, name) => {
        outgoingHeaders[name] = value
      })
      const request = http.request(
        url,
        {
          method: init.method,
          headers: outgoingHeaders,
          signal: init.signal ?? undefined,
        },
        (response) =>
          resolve(
            new Response(Readable.toWeb(response) as ReadableStream, {
              status: response.statusCode ?? 500,
              headers: response.headers as HeadersInit,
            }),
          ),
      )
      request.on('error', reject)
      request.end(init.body as string | Uint8Array | undefined)
    })
}

export function createGatewayOpenAIClient(
  config: AgentGatewayConfig,
  maxRetries = 2,
): OpenAI {
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.apiUrl,
    fetch: createGatewayFetch(config.vhost),
    timeout: config.timeoutMs,
    maxRetries,
  })
}
