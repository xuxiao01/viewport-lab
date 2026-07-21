<template>
  <header class="app-header">
    <div>
      <div class="brand-row">
        <span class="brand-mark" aria-hidden="true"></span>
        <h1>Viewport Lab</h1>
      </div>
      <p>批量检查 H5 页面在常用移动端视口下的展示效果</p>
    </div>
    <span class="runtime-badge"><i></i> 本地 Chromium</span>
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 0 18px;
}

.brand-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.brand-mark {
  width: 11px;
  height: 24px;
  border-radius: 4px;
  background: linear-gradient(180deg, var(--color-primary), var(--color-primary-dark));
}

h1 {
  margin: 0;
  color: var(--color-text-strong);
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

p {
  margin: 7px 0 0 21px;
  color: var(--color-text-muted);
  font-size: 14px;
}

.runtime-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 7px 11px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  color: var(--color-text-secondary);
  background: var(--color-surface);
  font-size: 12px;
  font-weight: 600;
}

.runtime-badge i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-success);
  box-shadow: 0 0 0 3px var(--color-success-soft);
}

@media (max-width: 640px) {
  .app-header {
    align-items: flex-start;
  }

  .runtime-badge {
    display: none;
  }

  p {
    margin-left: 0;
  }
}
</style>
