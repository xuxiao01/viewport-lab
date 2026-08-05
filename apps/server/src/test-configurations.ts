import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  agentModelNames,
  agentTurnLimits,
  batchNoteMaxLength,
  defaultAgentModel,
  terminalAgentRunStatuses,
} from '@viewport-lab/shared'
import type { AgentModelName } from '@viewport-lab/shared'
import type {
  AgentRun,
  ApiErrorResponse,
  BatchManifest,
  GetTestConfigurationResponse,
  ListTestConfigurationsResponse,
  SaveTestConfigurationRequest,
  SaveTestConfigurationResponse,
  ScreenshotDevicePresetSnapshot,
  ScreenshotDeviceRun,
  TestConfiguration,
  TestConfigurationSummary,
} from '@viewport-lab/shared'
import type { FastifyInstance } from 'fastify'

import { archiveIdPattern, createArchiveId } from './run-archive.js'

const rootDir = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const runsDir = resolve(rootDir, 'data/runs')
const configurationsDir = resolve(rootDir, 'data/configurations')
const terminalViewportStatuses = new Set<BatchManifest['status']>([
  'completed',
  'partial_failed',
  'failed',
])

let mutationQueue = Promise.resolve()

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function configurationPath(configId: string): string {
  return resolve(configurationsDir, `${configId}.json`)
}

function parseSaveRequest(value: unknown): SaveTestConfigurationRequest | null {
  if (!isRecord(value)) return null
  const { sourceKind, sourceRunId, name } = value
  if (
    (sourceKind !== 'viewport' && sourceKind !== 'agent') ||
    typeof sourceRunId !== 'string' ||
    !archiveIdPattern.test(sourceRunId) ||
    typeof name !== 'string'
  ) {
    return null
  }
  const normalizedName = name.trim()
  if (normalizedName.length === 0 || normalizedName.length > batchNoteMaxLength) return null
  return { sourceKind, sourceRunId, name: normalizedName }
}

function toDeviceSnapshot(
  device: ScreenshotDevicePresetSnapshot | ScreenshotDeviceRun,
): ScreenshotDevicePresetSnapshot {
  return {
    selectionId: device.selectionId,
    platformId: device.platformId,
    platformName: device.platformName,
    presetId: device.presetId,
    presetName: device.presetName,
    viewport: { ...device.viewport },
    deviceScaleFactor: device.deviceScaleFactor,
    isMobile: device.isMobile,
    hasTouch: device.hasTouch,
    fullPage: device.fullPage,
    readySelector: device.readySelector,
    captureDelayMs: device.captureDelayMs,
  }
}

async function readSourceManifest(sourceRunId: string): Promise<BatchManifest | AgentRun | null> {
  try {
    const contents = await readFile(resolve(runsDir, sourceRunId, 'manifest.json'), 'utf8')
    const manifest = JSON.parse(contents) as unknown
    if (!isRecord(manifest)) return null
    if (
      manifest.batchId === sourceRunId &&
      (manifest.kind === undefined || manifest.kind === 'viewport')
    ) {
      return { ...(manifest as unknown as BatchManifest), kind: 'viewport' }
    }
    if (manifest.kind === 'agent' && manifest.runId === sourceRunId) {
      return manifest as unknown as AgentRun
    }
    return null
  } catch {
    return null
  }
}

async function readConfiguration(configId: string): Promise<TestConfiguration | null> {
  if (!archiveIdPattern.test(configId)) return null
  try {
    const contents = await readFile(configurationPath(configId), 'utf8')
    const configuration = JSON.parse(contents) as TestConfiguration
    if (
      configuration.configId !== configId ||
      (configuration.kind !== 'viewport' && configuration.kind !== 'agent') ||
      typeof configuration.name !== 'string' ||
      typeof configuration.sourceRunId !== 'string' ||
      typeof configuration.createdAt !== 'string' ||
      typeof configuration.url !== 'string' ||
      typeof configuration.note !== 'string' ||
      !Array.isArray(configuration.devices) ||
      !configuration.devices.every(
        (device) =>
          typeof device.selectionId === 'string' &&
          typeof device.platformName === 'string' &&
          typeof device.presetName === 'string',
      ) ||
      (configuration.kind === 'viewport' &&
        configuration.captureDelayMs !== 0 &&
        configuration.captureDelayMs !== 30_000) ||
      (configuration.kind === 'agent' &&
        (typeof configuration.task !== 'string' ||
          !Number.isInteger(configuration.maxTurns) ||
          configuration.maxTurns < 1 ||
          configuration.maxTurns > agentTurnLimits.max ||
          (configuration.model !== undefined &&
            !agentModelNames.includes(configuration.model as AgentModelName))))
    ) {
      return null
    }
    return configuration.kind === 'agent'
      ? {
          ...configuration,
          model:
            typeof configuration.model === 'string' &&
            agentModelNames.includes(configuration.model as AgentModelName)
              ? (configuration.model as AgentModelName)
              : defaultAgentModel,
        }
      : configuration
  } catch {
    return null
  }
}

async function listConfigurations(): Promise<TestConfiguration[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(configurationsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const configurations = await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.endsWith('.json') &&
          archiveIdPattern.test(entry.name.slice(0, -5)),
      )
      .map((entry) => readConfiguration(entry.name.slice(0, -5))),
  )
  return configurations
    .filter((configuration): configuration is TestConfiguration => configuration !== null)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

function toSummary(configuration: TestConfiguration): TestConfigurationSummary {
  return {
    configId: configuration.configId,
    name: configuration.name,
    kind: configuration.kind,
    sourceRunId: configuration.sourceRunId,
    createdAt: configuration.createdAt,
    url: configuration.url,
    note: configuration.note,
    task: configuration.kind === 'agent' ? configuration.task : null,
    captureDelayMs: configuration.kind === 'viewport' ? configuration.captureDelayMs : null,
    maxTurns: configuration.kind === 'agent' ? configuration.maxTurns : null,
    deviceCount: configuration.devices.length,
    deviceNames: configuration.devices.map(
      (device) => `${device.platformName} · ${device.presetName}`,
    ),
  }
}

function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(operation, operation)
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

async function saveConfiguration(
  request: SaveTestConfigurationRequest,
): Promise<SaveTestConfigurationResponse | null | 'not-terminal'> {
  return serializeMutation(async () => {
    const existing = (await listConfigurations()).find(
      (configuration) =>
        configuration.kind === request.sourceKind &&
        configuration.sourceRunId === request.sourceRunId,
    )
    if (existing) return { configuration: existing, created: false }

    const source = await readSourceManifest(request.sourceRunId)
    if (!source || source.kind !== request.sourceKind) return null
    if (
      (source.kind === 'viewport' && !terminalViewportStatuses.has(source.status)) ||
      (source.kind === 'agent' && !terminalAgentRunStatuses.has(source.status))
    ) {
      return 'not-terminal'
    }

    const createdAt = new Date()
    const configId = createArchiveId(createdAt)
    const base = {
      configId,
      name: request.name,
      sourceRunId: request.sourceRunId,
      createdAt: createdAt.toISOString(),
      url: source.url,
      note: source.note,
      devices: source.devices.map(toDeviceSnapshot),
    }
    const configuration: TestConfiguration =
      source.kind === 'viewport'
        ? {
            ...base,
            kind: 'viewport',
            captureDelayMs: source.captureDelayMs ?? 0,
          }
        : {
            ...base,
            kind: 'agent',
            task: source.task,
            maxTurns: source.maxTurns,
            model:
              typeof source.model === 'string' &&
              agentModelNames.includes(source.model as AgentModelName)
                ? (source.model as AgentModelName)
                : defaultAgentModel,
          }

    await mkdir(configurationsDir, { recursive: true })
    await writeFile(
      configurationPath(configId),
      `${JSON.stringify(configuration, null, 2)}\n`,
      'utf8',
    )
    return { configuration, created: true }
  })
}

export async function registerTestConfigurationRoutes(app: FastifyInstance): Promise<void> {
  await mkdir(configurationsDir, { recursive: true })

  app.get<{ Reply: ListTestConfigurationsResponse }>('/api/test-configurations', async () => ({
    configurations: (await listConfigurations()).map(toSummary),
  }))

  app.get<{
    Params: { configId: string }
    Reply: GetTestConfigurationResponse | ApiErrorResponse
  }>('/api/test-configurations/:configId', async (request, reply) => {
    const configuration = await readConfiguration(request.params.configId)
    if (!configuration) return reply.code(404).send({ error: 'Test configuration not found' })
    return reply.send({ configuration })
  })

  app.post<{
    Body: unknown
    Reply: SaveTestConfigurationResponse | ApiErrorResponse
  }>('/api/test-configurations', async (request, reply) => {
    const parsed = parseSaveRequest(request.body)
    if (!parsed) return reply.code(400).send({ error: 'Invalid test configuration request' })
    const result = await saveConfiguration(parsed)
    if (!result) return reply.code(404).send({ error: 'Source run not found' })
    if (result === 'not-terminal') {
      return reply.code(409).send({ error: 'Running batches cannot be saved as configurations' })
    }
    return reply.code(result.created ? 201 : 200).send(result)
  })

  app.delete<{ Params: { configId: string } }>(
    '/api/test-configurations/:configId',
    async (request, reply) => {
      const configuration = await readConfiguration(request.params.configId)
      if (!configuration) return reply.code(404).send({ error: 'Test configuration not found' })
      await rm(configurationPath(configuration.configId))
      return reply.code(204).send()
    },
  )
}
