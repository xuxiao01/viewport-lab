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

import { archiveIdPattern } from '../run-archive.js'
import { agentRunsDir } from './config.js'

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
  if (!archiveIdPattern.test(runId)) throw new Error(`Invalid agent run id: ${runId}`)
  const runDir = resolve(agentRunsDir, runId)
  const eventsPath = resolve(runDir, 'events.jsonl')
  await mkdir(runDir, { recursive: true })
  return { runDir, eventsPath }
}

export async function ensureDeviceDirs(runId: string, deviceId: string): Promise<DeviceRunDirs> {
  const runDir = resolve(agentRunsDir, runId)
  const safeId = sanitizeDeviceDir(deviceId)
  const deviceDir = resolve(runDir, 'agent', safeId)
  const screenshotsDir = resolve(deviceDir, 'steps')
  const snapshotsDir = resolve(deviceDir, 'snapshots')
  const specDir = deviceDir
  const finalScreenshotPath = resolve(runDir, `${safeId}.png`)
  await mkdir(screenshotsDir, { recursive: true })
  await mkdir(snapshotsDir, { recursive: true })
  return { deviceDir, screenshotsDir, snapshotsDir, specDir, finalScreenshotPath }
}

export async function clearDeviceArtifacts(runId: string, deviceId: string): Promise<void> {
  if (!archiveIdPattern.test(runId)) throw new Error(`Invalid agent run id: ${runId}`)
  const safeId = sanitizeDeviceDir(deviceId)
  await Promise.all([
    rm(resolve(agentRunsDir, runId, 'agent', safeId), { recursive: true, force: true }),
    rm(resolve(agentRunsDir, runId, `${safeId}.png`), { force: true }),
  ])
}

/** Clears only transient Agent evidence, preserving the root final screenshot. */
export async function clearDeviceAgentArtifacts(runId: string, deviceId: string): Promise<void> {
  if (!archiveIdPattern.test(runId)) throw new Error(`Invalid agent run id: ${runId}`)
  await rm(resolve(agentRunsDir, runId, 'agent', sanitizeDeviceDir(deviceId)), {
    recursive: true,
    force: true,
  })
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
  finalScreenshotPath: string
}

export class AgentRunRecorder {
  run: AgentRun
  private readonly runDir: string
  private readonly eventsPath: string
  private persistQueue = Promise.resolve()

  constructor(persisted: AgentRunPersisted, run: AgentRun) {
    this.run = run
    this.runDir = persisted.runDir
    this.eventsPath = persisted.eventsPath
  }

  async persist(): Promise<void> {
    const snapshot = `${JSON.stringify(this.run, null, 2)}\n`
    const next = this.persistQueue
      .catch(() => undefined)
      .then(() => writeFile(resolve(this.runDir, 'manifest.json'), snapshot, 'utf8'))
    this.persistQueue = next
    await next
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

const activeAgentRecorders = new Map<string, AgentRunRecorder>()

export function registerActiveAgentRecorder(recorder: AgentRunRecorder): void {
  activeAgentRecorders.set(recorder.run.runId, recorder)
}

export function unregisterActiveAgentRecorder(runId: string, recorder: AgentRunRecorder): void {
  if (activeAgentRecorders.get(runId) === recorder) activeAgentRecorders.delete(runId)
}

export async function updateAgentRunNote(runId: string, note: string): Promise<AgentRun | null> {
  const activeRecorder = activeAgentRecorders.get(runId)
  if (activeRecorder) {
    activeRecorder.update({ note })
    await activeRecorder.persist()
    return activeRecorder.run
  }
  const run = await readAgentRun(runId)
  if (!run) return null
  const recorder = new AgentRunRecorder(await ensureRunDirs(runId), run)
  recorder.update({ note })
  await recorder.persist()
  return recorder.run
}

export async function updateAgentRerunList(
  run: AgentRun,
  deviceId: string,
  included: boolean,
): Promise<string[]> {
  const ids = new Set(run.rerunDeviceIds)
  if (included) ids.add(deviceId)
  else ids.delete(deviceId)
  const rerunDeviceIds = run.devices
    .map((device) => device.selectionId)
    .filter((selectionId) => ids.has(selectionId))
  const recorder = new AgentRunRecorder(await ensureRunDirs(run.runId), run)
  recorder.update({ rerunDeviceIds })
  await recorder.persist()
  return rerunDeviceIds
}

export async function readAgentRun(runId: string): Promise<AgentRun | null> {
  if (!archiveIdPattern.test(runId)) return null
  try {
    const contents = await readFile(runManifestPath(runId), 'utf8')
    const run = JSON.parse(contents) as AgentRun
    if (run.kind !== 'agent' || run.runId !== runId) return null
    if (!run.deviceRuns) return null
    return normalizeAgentRun(run)
  } catch {
    return null
  }
}

export function normalizeAgentRun(run: AgentRun): AgentRun {
  if (
    run.executionMode !== 'leader_broadcast' &&
    run.executionMode !== 'leader_resize_capture' &&
    run.executionMode !== 'per_device'
  ) {
    run.executionMode = 'per_device'
  }
  const configuredDeviceIds = new Set(
    Array.isArray(run.devices) ? run.devices.map((device) => device.selectionId) : [],
  )
  if (run.executionMode === 'leader_broadcast' || run.executionMode === 'leader_resize_capture') {
    run.leaderDeviceId =
      typeof run.leaderDeviceId === 'string' && configuredDeviceIds.has(run.leaderDeviceId)
        ? run.leaderDeviceId
        : (run.devices[0]?.selectionId ?? null)
  } else {
    run.leaderDeviceId = null
  }
  const validDeviceIds = new Set(run.deviceRuns.map((deviceRun) => deviceRun.deviceId))
  run.deviceRuns = run.deviceRuns.map((deviceRun) => ({
    ...deviceRun,
    steps: (deviceRun.steps ?? []).map((step) => ({
      ...step,
      error: typeof step.error === 'string' ? step.error : null,
      wait: step.wait ?? null,
      page: step.page ?? null,
      snapshotMeta: step.snapshotMeta ?? null,
    })),
  }))
  run.rerunDeviceIds = Array.isArray(run.rerunDeviceIds)
    ? run.rerunDeviceIds.filter(
        (deviceId): deviceId is string =>
          typeof deviceId === 'string' && validDeviceIds.has(deviceId),
      )
    : []
  return run
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
      .filter((entry) => entry.isDirectory() && archiveIdPattern.test(entry.name))
      .map((entry) => readAgentRun(entry.name)),
  )
  return runs
    .filter((run): run is AgentRun => run !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export async function normalizeInterruptedAgentRuns(): Promise<void> {
  const interruptedAt = nowIso()
  for (const run of await listAgentRuns()) {
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') continue
    const recorder = new AgentRunRecorder(await ensureRunDirs(run.runId), {
      ...run,
      status: 'failed',
      updatedAt: interruptedAt,
      completedAt: interruptedAt,
      error: 'Agent 服务已重启，任务未能完成',
      durationMs: Math.max(
        0,
        new Date(interruptedAt).getTime() - new Date(run.createdAt).getTime(),
      ),
      deviceRuns: run.deviceRuns.map((deviceRun) =>
        deviceRun.status === 'completed' ||
        deviceRun.status === 'failed' ||
        deviceRun.status === 'cancelled'
          ? deviceRun
          : {
              ...deviceRun,
              status: 'failed',
              error: 'Agent 服务已重启，任务未能完成',
            },
      ),
    })
    await recorder.persist()
  }
}

const retryIdPattern = /^[0-9a-f-]{36}$/i

function retriesDir(runId: string): string {
  return resolve(agentRunsDir, runId, 'agent', 'retries')
}

function retryManifestPath(runId: string, retryId: string): string {
  return resolve(retriesDir(runId), retryId, 'manifest.json')
}

export async function writeRetryRun(retry: RetryRun): Promise<void> {
  if (!archiveIdPattern.test(retry.runId)) return
  const dir = resolve(retriesDir(retry.runId), retry.retryId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    retryManifestPath(retry.runId, retry.retryId),
    `${JSON.stringify(retry, null, 2)}\n`,
    'utf8',
  )
}

export async function readRetryRun(runId: string, retryId: string): Promise<RetryRun | null> {
  if (!archiveIdPattern.test(runId) || !retryIdPattern.test(retryId)) return null
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
  if (!archiveIdPattern.test(runId)) return []
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
