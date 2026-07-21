<script setup lang="ts">
import { computed } from 'vue'

import type { ViewportPreset } from '../types/capture'

const props = defineProps<{
  preset: ViewportPreset
  selected: boolean
  disabled: boolean
}>()

defineEmits<{
  toggle: []
}>()

const visibleModels = computed(() => props.preset.representativeModels.slice(0, 3))
const hiddenModelCount = computed(() => Math.max(0, props.preset.representativeModels.length - 3))
</script>

<template>
  <article
    class="preset-card"
    :class="{ selected, disabled }"
    role="checkbox"
    :aria-checked="selected"
    :aria-disabled="disabled"
    :tabindex="disabled ? -1 : 0"
    @click="!disabled && $emit('toggle')"
    @keydown.enter.prevent="!disabled && $emit('toggle')"
    @keydown.space.prevent="!disabled && $emit('toggle')"
  >
    <div class="preset-heading">
      <div>
        <h3>{{ preset.viewport.width }} × {{ preset.viewport.height }}</h3>
        <p>{{ preset.description }}</p>
      </div>
      <span class="selection-mark" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none">
          <path d="m3.5 8.2 2.8 2.8 6.2-6.2" stroke="currentColor" stroke-width="1.8" />
        </svg>
      </span>
    </div>

    <div v-if="preset.representativeModels.length > 0" class="models-block">
      <span class="models-label">代表机型</span>
      <div class="model-tags">
        <span v-for="model in visibleModels" :key="model" class="model-tag">{{ model }}</span>
        <el-popover v-if="hiddenModelCount > 0" placement="top" trigger="hover" :width="220">
          <ul class="all-models">
            <li v-for="model in preset.representativeModels" :key="model">{{ model }}</li>
          </ul>
          <template #reference>
            <span class="more-models" tabindex="0" @click.stop>
              +{{ hiddenModelCount }} 个代表机型
            </span>
          </template>
        </el-popover>
      </div>
    </div>
  </article>
</template>

<style scoped>
.preset-card {
  display: grid;
  grid-template-rows: auto 1fr;
  gap: 18px;
  min-width: 0;
  min-height: 176px;
  padding: 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-surface);
  cursor: pointer;
  transition:
    border-color 160ms ease,
    box-shadow 160ms ease,
    background 160ms ease;
}

.preset-card:hover {
  border-color: var(--color-primary-border);
}

.preset-card:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

.preset-card.selected {
  border-color: var(--color-primary);
  background: var(--color-primary-soft);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-primary) 10%, transparent);
}

.preset-card.disabled {
  cursor: not-allowed;
  opacity: 0.72;
}

.preset-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

h3 {
  margin: 0;
  color: var(--color-text-strong);
  font-size: 18px;
  letter-spacing: -0.02em;
}

p {
  margin: 6px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.45;
}

.selection-mark {
  display: grid;
  place-items: center;
  flex: 0 0 auto;
  width: 21px;
  height: 21px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: transparent;
  background: #fff;
}

.selection-mark svg {
  width: 14px;
  height: 14px;
}

.selected .selection-mark {
  border-color: var(--color-primary);
  color: #fff;
  background: var(--color-primary);
}

.models-block {
  align-self: end;
}

.models-label {
  display: block;
  margin-bottom: 7px;
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 650;
}

.model-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.model-tag,
.more-models {
  padding: 4px 7px;
  border: 1px solid var(--color-border-light);
  border-radius: 6px;
  color: var(--color-text-secondary);
  background: rgb(255 255 255 / 76%);
  font-size: 10px;
  line-height: 1.2;
}

.more-models {
  border-color: var(--color-primary-border);
  color: var(--color-primary-dark);
  cursor: help;
}

.more-models:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}

.all-models {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 2px 2px 2px 18px;
  color: var(--color-text-secondary);
  font-size: 12px;
}
</style>
