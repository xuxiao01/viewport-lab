<script setup lang="ts">
import { computed } from 'vue'

import ApplePresetSelector from './ApplePresetSelector.vue'
import PlatformCard from './PlatformCard.vue'
import { getPlatformPresetIds } from '../config/viewport-presets'
import type { PlatformPresetGroup, SelectionState } from '../types/capture'

const props = defineProps<{
  platforms: PlatformPresetGroup[]
  selectedPresetIds: string[]
  disabled: boolean
}>()

const emit = defineEmits<{
  'update:selectedPresetIds': [value: string[]]
}>()

const applePhonePlatform = computed(() =>
  props.platforms.find((platform) => platform.id === 'ios-phone'),
)

function getSelectionState(platform: PlatformPresetGroup): SelectionState {
  const presetIds = getPlatformPresetIds(platform)
  const selectedCount = presetIds.filter((id) => props.selectedPresetIds.includes(id)).length
  if (selectedCount === 0) return 'unchecked'
  if (selectedCount === presetIds.length) return 'checked'
  return 'indeterminate'
}

function togglePlatform(platform: PlatformPresetGroup): void {
  const presetIds = getPlatformPresetIds(platform)
  const shouldClear = getSelectionState(platform) === 'checked'
  const otherIds = props.selectedPresetIds.filter((id) => !presetIds.includes(id))
  emit('update:selectedPresetIds', shouldClear ? otherIds : [...otherIds, ...presetIds])
}

function updateSelectedPresetIds(value: string[]): void {
  emit('update:selectedPresetIds', value)
}
</script>

<template>
  <div>
    <div class="selector-grid">
      <PlatformCard
        v-for="platform in platforms"
        :key="platform.id"
        :platform="platform"
        :selection-state="getSelectionState(platform)"
        :disabled="disabled"
        @toggle="togglePlatform(platform)"
      />
    </div>
    <ApplePresetSelector
      v-if="applePhonePlatform && getSelectionState(applePhonePlatform) !== 'unchecked'"
      :platform="applePhonePlatform"
      :selected-preset-ids="selectedPresetIds"
      :disabled="disabled"
      @update:selected-preset-ids="updateSelectedPresetIds"
    />
  </div>
</template>

<style scoped>
.selector-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
}

@media (max-width: 1050px) {
  .selector-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 580px) {
  .selector-grid {
    grid-template-columns: 1fr;
  }
}
</style>
