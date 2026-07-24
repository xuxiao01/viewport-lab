import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { resolve } from 'node:path'

import type {
  AgentRun,
  AgentRunStatus,
  DeviceAgentRun,
  DeviceAgentStep,
  RetryRun,
  RetryRunSummary,
} from '@viewport-lab/shared'

import { agentRunsDir } from './config.js'

const runIdPattern = /^[0-9a-f-]{36}$/i

export function sanitizeDeviceDir(deviceId: string): string {
  return deviceId.replace(/:/g, '-')
}

function nowIso(): string {
  return new Date().toISOString()
}

function runManifestPath(runId: string): string {
  return resolve(agentRunsDir, runId, 'manifest.json')
}

export async function ensureRunDirs(runId: string): Promise<AgentRunPersisted> {
  if (!runIdPattern.test(runId)) throw new Error(`Invalid agent run id: ${runId}`)
  const runDir = resolve(agentRunsDir, runId)
  const eventsPath = resolve(runDir, 'events.jsonl')
  await mkdir(runDir, { recursive: true })
  return { runDir, eventsPath }
}

export async function ensureDeviceDirs(runId: string, deviceId: string): Promise<DeviceRunDirs> {
  const runDir = resolve(agentRunsDir, runId)
  const safeId = sanitizeDeviceDir(deviceId)
  const deviceDir = resolve(runDir, safeId)
  const screenshotsDir = resolve(deviceDir, 'screenshots')
  const snapshotsDir = resolve(deviceDir, 'snapshots')
  const specDir = deviceDir
  await mkdir(screenshotsDir, { recursive: true })
  await mkdir(snapshotsDir, { recursive: true })
  return { deviceDir, screenshotsDir, snapshotsDir, specDir }
}

export interface AgentRunPersisted {
  runDir: string
  eventsPath: string
}

export interface DeviceRunDirs {
  deviceDir: string
  screenshotsDir: string
  snapshotsDir: string
  specDir: string
}

export class AgentRunRecorder {
  run: AgentRun
  private readonly runDir: string
  private readonly eventsPath: string

  constructor(persisted: AgentRunPersisted, run: AgentRun) {
    this.run = run
    this.runDir = persisted.runDir
    this.eventsPath = persisted.eventsPath
  }

  async persist(): Promise<void> {
    await writeFile(
      runManifestPath(this.run.runId),
      `${JSON.stringify(this.run, null, 2)}\n`,
      'utf8',
    )
  }

  async appendEvent(event: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify({ timestamp: nowIso(), ...event })}\n`
    const { appendFile } = await import('node:fs/promises')
    await appendFile(this.eventsPath, line, 'utf8')
  }

  update(patch: Partial<AgentRun>): void {
    Object.assign(this.run, patch, { updatedAt: nowIso() })
  }

  setStatus(status: AgentRunStatus, error: string | null = null): void {
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
    this.update({
      status,
      error,
      completedAt: terminal ? nowIso() : this.run.completedAt,
      durationMs: terminal
        ? Math.max(
            0,
            new Date(this.run.completedAt ?? nowIso()).getTime() -
              new Date(this.run.createdAt).getTime(),
          )
        : null,
    })
  }

  updateDeviceRun(deviceId: string, patch: Partial<DeviceAgentRun>): void {
    this.run.deviceRuns = this.run.deviceRuns.map((dr) =>
      dr.deviceId === deviceId ? { ...dr, ...patch } : dr,
    )
  }

  appendDeviceStep(deviceId: string, step: DeviceAgentStep): void {
    this.run.deviceRuns = this.run.deviceRuns.map((dr) =>
      dr.deviceId === deviceId ? { ...dr, steps: [...dr.steps, step] } : dr,
    )
  }

  setDeviceStatus(deviceId: string, status: AgentRunStatus, error: string | null = null): void {
    this.updateDeviceRun(deviceId, {
      status,
      error,
      ...(status === 'completed' || status === 'failed' || status === 'cancelled' ? {} : {}),
    })
  }

  async delete(): Promise<void> {
    await rm(this.runDir, { recursive: true })
  }
}

export async function readAgentRun(runId: string): Promise<AgentRun | null> {
  if (!runIdPattern.test(runId)) return null
  try {
    const contents = await readFile(runManifestPath(runId), 'utf8')
    const run = JSON.parse(contents) as AgentRun
    if (run.runId !== runId) return null
    if (!run.deviceRuns) return null
    return run
  } catch {
    return null
  }
}

export async function listAgentRuns(): Promise<AgentRun[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(agentRunsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const runs = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && runIdPattern.test(entry.name))
      .map((entry) => readAgentRun(entry.name)),
  )
  return runs
    .filter((run): run is AgentRun => run !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

const retryIdPattern = /^[0-9a-f-]{36}$/i

function retriesDir(runId: string): string {
  return resolve(agentRunsDir, runId, 'retries')
}

function retryManifestPath(runId: string, retryId: string): string {
  return resolve(retriesDir(runId), retryId, 'manifest.json')
}

export async function writeRetryRun(retry: RetryRun): Promise<void> {
  if (!runIdPattern.test(retry.runId)) return
  const dir = resolve(retriesDir(retry.runId), retry.retryId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    retryManifestPath(retry.runId, retry.retryId),
    `${JSON.stringify(retry, null, 2)}\n`,
    'utf8',
  )
}

export async function readRetryRun(runId: string, retryId: string): Promise<RetryRun | null> {
  if (!runIdPattern.test(runId) || !retryIdPattern.test(retryId)) return null
  try {
    const contents = await readFile(retryManifestPath(runId, retryId), 'utf8')
    return JSON.parse(contents) as RetryRun
  } catch {
    return null
  }
}

export function toRetrySummary(retry: RetryRun): RetryRunSummary {
  const passed = retry.deviceResults.filter((d) => d.status === 'passed').length
  const failed = retry.deviceResults.filter((d) => d.status === 'failed').length
  const skipped = retry.deviceResults.filter((d) => d.status === 'skipped').length
  return {
    retryId: retry.retryId,
    runId: retry.runId,
    startedAt: retry.startedAt,
    completedAt: retry.completedAt,
    status: retry.status,
    deviceCount: retry.deviceResults.length,
    passedCount: passed,
    failedCount: failed,
    skippedCount: skipped,
  }
}

export async function listRetryRuns(runId: string): Promise<RetryRunSummary[]> {
  if (!runIdPattern.test(runId)) return []
  let entries: Dirent[]
  try {
    entries = await readdir(retriesDir(runId), { withFileTypes: true })
  } catch {
    return []
  }
  const retries = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && retryIdPattern.test(entry.name))
      .map((entry) => readRetryRun(runId, entry.name)),
  )
  return retries
    .filter((retry): retry is RetryRun => retry !== null)
    .map(toRetrySummary)
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
}

export async function ensureRetryDeviceDir(
  runId: string,
  retryId: string,
  deviceId: string,
): Promise<string> {
  const safeId = sanitizeDeviceDir(deviceId)
  const dir = resolve(retriesDir(runId), retryId, safeId, 'screenshots')
  await mkdir(dir, { recursive: true })
  return resolve(retriesDir(runId), retryId, safeId)
}

export async function listRetryScreenshots(
  runId: string,
  retryId: string,
  deviceId: string,
): Promise<string[]> {
  const safeId = sanitizeDeviceDir(deviceId)
  const dir = resolve(retriesDir(runId), retryId, safeId, 'screenshots')
  try {
    const files = await readdir(dir)
    return files.filter((f) => f.endsWith('.png')).sort()
  } catch {
    return []
  }
}
