import {
  agentModelNames,
  agentTurnLimits,
  defaultAgentModel,
  type AgentModelName,
  type CaptureDelayMs,
} from '@viewport-lab/shared'

import { getPlatformPresetIds, viewportPresets } from '../config/viewport-presets'
import type { PlatformId } from '../types/capture'

export const taskDraftStorageKey = 'viewport-lab:create-task-draft:v1'

export interface TaskDraft {
  url: string
  note: string
  aiTaskDescription: string
  maxTurns: number
  model: AgentModelName
  captureDelayMs: CaptureDelayMs
  selectedCategories: PlatformId[]
  activeCategory: PlatformId | null
  selectedPresetIds: string[]
  initializedCategories: PlatformId[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const validPlatformIds = new Set(viewportPresets.map((platform) => platform.id))
const orderedPresetIds = viewportPresets.flatMap(getPlatformPresetIds)
const validPresetIds = new Set(orderedPresetIds)

function validPlatforms(value: unknown, fallback: PlatformId[]): PlatformId[] {
  if (!Array.isArray(value)) return [...fallback]
  const selected = new Set(
    value.filter(
      (item): item is PlatformId =>
        typeof item === 'string' && validPlatformIds.has(item as PlatformId),
    ),
  )
  return viewportPresets
    .filter((platform) => selected.has(platform.id))
    .map((platform) => platform.id)
}

function validPresets(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const selected = new Set(
    value.filter((item): item is string => typeof item === 'string' && validPresetIds.has(item)),
  )
  return orderedPresetIds.filter((presetId) => selected.has(presetId))
}

export function loadTaskDraft(fallback: TaskDraft): TaskDraft {
  let parsed: unknown
  try {
    const saved = window.localStorage.getItem(taskDraftStorageKey)
    if (!saved) return fallback
    parsed = JSON.parse(saved) as unknown
  } catch {
    try {
      window.localStorage.removeItem(taskDraftStorageKey)
    } catch {
      // localStorage may be unavailable
    }
    return fallback
  }
  if (!isRecord(parsed)) return fallback

  const selectedCategories = validPlatforms(parsed.selectedCategories, fallback.selectedCategories)
  const restoredInitializedCategories = validPlatforms(
    parsed.initializedCategories,
    fallback.initializedCategories,
  )
  const initializedSet = new Set([...restoredInitializedCategories, ...selectedCategories])
  const initializedCategories = viewportPresets
    .filter((platform) => initializedSet.has(platform.id))
    .map((platform) => platform.id)
  const activeCategory =
    typeof parsed.activeCategory === 'string' &&
    selectedCategories.includes(parsed.activeCategory as PlatformId)
      ? (parsed.activeCategory as PlatformId)
      : (selectedCategories[0] ?? null)

  return {
    url: typeof parsed.url === 'string' ? parsed.url : fallback.url,
    note: typeof parsed.note === 'string' ? parsed.note.slice(0, 200) : fallback.note,
    aiTaskDescription:
      typeof parsed.aiTaskDescription === 'string'
        ? parsed.aiTaskDescription
        : fallback.aiTaskDescription,
    maxTurns:
      typeof parsed.maxTurns === 'number' &&
      Number.isInteger(parsed.maxTurns) &&
      parsed.maxTurns >= agentTurnLimits.min &&
      parsed.maxTurns <= agentTurnLimits.max
        ? parsed.maxTurns
        : fallback.maxTurns,
    model:
      typeof parsed.model === 'string' && agentModelNames.includes(parsed.model as AgentModelName)
        ? (parsed.model as AgentModelName)
        : (fallback.model ?? defaultAgentModel),
    captureDelayMs:
      parsed.captureDelayMs === 0 || parsed.captureDelayMs === 30_000
        ? parsed.captureDelayMs
        : fallback.captureDelayMs,
    selectedCategories,
    activeCategory,
    selectedPresetIds: validPresets(parsed.selectedPresetIds, fallback.selectedPresetIds),
    initializedCategories,
  }
}

export function saveTaskDraft(draft: TaskDraft): void {
  try {
    window.localStorage.setItem(taskDraftStorageKey, JSON.stringify(draft))
  } catch {
    // A blocked or full localStorage must not prevent task creation.
  }
}
