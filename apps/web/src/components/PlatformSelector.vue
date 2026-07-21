<script setup lang="ts">
import PlatformCard from './PlatformCard.vue'
import { getPlatformPresetIds } from '../config/viewport-presets'
import type { PlatformId, PlatformPresetGroup } from '../types/capture'

const props = defineProps<{
  platforms: PlatformPresetGroup[]
  selectedCategories: PlatformId[]
  selectedPresetIds: string[]
  disabled: boolean
}>()

const emit = defineEmits<{
  toggleCategory: [platformId: PlatformId]
}>()

function getSelectedCount(platform: PlatformPresetGroup): number {
  const presetIds = getPlatformPresetIds(platform)
  return presetIds.filter((id) => props.selectedPresetIds.includes(id)).length
}
</script>

<template>
  <div class="selector-grid">
    <PlatformCard
      v-for="platform in platforms"
      :key="platform.id"
      :platform="platform"
      :selected="selectedCategories.includes(platform.id)"
      :selected-count="getSelectedCount(platform)"
      :total-count="platform.presets.length"
      :disabled="disabled"
      @toggle="emit('toggleCategory', platform.id)"
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
