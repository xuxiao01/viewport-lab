<script setup lang="ts">
import type { PlatformPresetGroup, SelectionState } from '../types/capture'

defineProps<{
  platform: PlatformPresetGroup
  selectionState: SelectionState
  disabled: boolean
}>()

defineEmits<{
  toggle: []
}>()
</script>

<template>
  <button
    type="button"
    class="platform-card"
    :class="{ active: selectionState !== 'unchecked' }"
    role="checkbox"
    :aria-checked="selectionState === 'indeterminate' ? 'mixed' : selectionState === 'checked'"
    :disabled="disabled"
    @click="$emit('toggle')"
  >
    <span class="platform-icon">{{ platform.shortName }}</span>
    <span class="platform-copy">
      <strong>{{ platform.name }}</strong>
      <small>{{ platform.presets.length }} 个预设</small>
    </span>
    <span class="selection-mark" aria-hidden="true">
      <svg v-if="selectionState === 'checked'" viewBox="0 0 16 16" fill="none">
        <path d="m3.5 8.2 2.8 2.8 6.2-6.2" stroke="currentColor" stroke-width="1.8" />
      </svg>
      <svg v-else-if="selectionState === 'indeterminate'" viewBox="0 0 16 16" fill="none">
        <path d="M3.5 8h9" stroke="currentColor" stroke-width="1.8" />
      </svg>
    </span>
  </button>
</template>

<style scoped>
.platform-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-strong);
  background: var(--color-surface);
  text-align: left;
  cursor: pointer;
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease,
    background 160ms ease;
}

.platform-card:hover {
  border-color: var(--color-primary-border);
}

.platform-card:disabled {
  cursor: not-allowed;
  opacity: 0.72;
}

.platform-card.active {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 12%, transparent);
}

.platform-icon {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 11px;
  color: var(--color-primary-dark);
  background: #fff;
  box-shadow: inset 0 0 0 1px var(--color-border-light);
  font-size: 11px;
  font-weight: 750;
  letter-spacing: -0.02em;
}

.platform-copy {
  display: grid;
  gap: 3px;
}

.platform-copy strong {
  font-size: 14px;
}

.platform-copy small {
  color: var(--color-text-muted);
  font-size: 12px;
}

.selection-mark {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: transparent;
  background: #fff;
}

.selection-mark svg {
  width: 14px;
  height: 14px;
}

.active .selection-mark {
  border-color: var(--color-primary);
  color: #fff;
  background: var(--color-primary);
}
</style>
