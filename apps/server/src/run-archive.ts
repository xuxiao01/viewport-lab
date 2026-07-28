import { randomUUID } from 'node:crypto'

export const archiveIdPattern = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}_[0-9a-f]{8}$/i

export function createArchiveId(date = new Date()): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0')
  const timestamp = [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`,
  ].join('_')

  return `${timestamp}_${randomUUID().slice(0, 8)}`
}
