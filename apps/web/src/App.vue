<script setup lang="ts">
import { useRoute } from 'vue-router'

const route = useRoute()
</script>

<template>
  <div class="app-shell">
    <nav class="app-tabs" aria-label="主要功能">
      <router-link to="/" class="app-tab" :class="{ active: route.name === 'home' }">
        创建检测任务
      </router-link>
      <router-link
        to="/font-check"
        class="app-tab"
        :class="{ active: route.name === 'font-check' }"
      >
        字体检查
      </router-link>
      <router-link
        to="/configurations"
        class="app-tab"
        :class="{ active: route.name === 'configurations' }"
      >
        配置清单
      </router-link>
    </nav>
    <router-view />
  </div>
</template>

<style scoped>
.app-shell {
  width: 100%;
}

.app-tabs {
  display: flex;
  gap: 6px;
  justify-content: center;
  padding: 10px 16px 0;
  border-bottom: 1px solid var(--color-border-light);
  background: var(--color-surface);
}

.app-tab {
  padding: 10px 18px;
  border-bottom: 2px solid transparent;
  color: var(--color-text-muted);
  font-size: 14px;
  font-weight: 650;
  text-decoration: none;
  transition:
    color 0.15s ease,
    border-color 0.15s ease;
}

.app-tab:hover {
  color: var(--color-text-secondary);
}

.app-tab.active {
  color: var(--color-primary-dark);
  border-bottom-color: var(--color-primary);
}
</style>
