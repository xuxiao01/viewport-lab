import { isIP } from 'node:net'

const loopbackHostnames = new Set(['localhost', 'localhost.', '127.0.0.1', '[::1]'])

function normalizeClientAddress(address: string): string | null {
  let normalized = address.trim()
  if (normalized.startsWith('::ffff:')) normalized = normalized.slice('::ffff:'.length)
  if (normalized.startsWith('[') && normalized.endsWith(']')) {
    normalized = normalized.slice(1, -1)
  }
  const zoneIndex = normalized.indexOf('%')
  if (zoneIndex >= 0) normalized = normalized.slice(0, zoneIndex)
  return isIP(normalized) === 0 ? null : normalized
}

export function resolveClientTargetUrl(targetUrl: string, clientAddress: string): string {
  const parsed = new URL(targetUrl)
  if (!loopbackHostnames.has(parsed.hostname.toLowerCase())) return targetUrl

  const normalizedAddress = normalizeClientAddress(clientAddress)
  if (!normalizedAddress) return targetUrl

  parsed.hostname = isIP(normalizedAddress) === 6 ? `[${normalizedAddress}]` : normalizedAddress
  return parsed.toString()
}
