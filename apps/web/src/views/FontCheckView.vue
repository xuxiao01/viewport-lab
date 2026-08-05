<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus'
import { computed, onMounted, reactive, ref } from 'vue'

import AppHeader from '../components/AppHeader.vue'

type ScenarioId =
  | 'ipad-820x1180'
  | 'ipad-768x1024'
  | 'ipad-810x1080'
  | 'android-tablet-800x1280'
  | 'android-tablet-640x876'
  | 'android-tablet-800x1088'
  | 'android-tablet-800x1164'
  | 'android-tablet-720x1100'
  | 'android-tablet-920x1400'

interface FontIssue {
  selector: string
  text: string
  cssFontPx: number
  simulatedCssFontPx: number
  visualFontPx: number
  estimatedDeviceFontPx: number
  fontFamily: string
  fontWeight: string
  rect: { x: number; y: number; width: number; height: number }
}

interface FontCheckMetrics {
  userAgent: string
  devicePixelRatio: number
  innerWidth: number
  innerHeight: number
  outerWidth: number
  screenWidth: number
  clientWidth: number
  visualViewportWidth: number | null
  visualViewportScale: number
  viewportContent: string
  textSizeAdjust: string
  containerUnitsSupported: boolean
  compatibilityMode: 'normal' | 'legacy-container-units'
  affectedContainerUnitTextCount: number
  inspectedTextCount: number
  issueCount: number
  issues: FontIssue[]
}

interface FontCheckResult {
  scenarioId: string
  scenarioName: string
  kind: 'baseline' | 'android' | 'compatibility'
  viewport: { width: number; height: number }
  httpStatus: number | null
  finalUrl: string
  screenshotUrl: string
  originalScreenshotUrl: string
  metrics: FontCheckMetrics | null
  error: string | null
}

interface FontCheckResponse {
  runId: string
  createdAt: string
  url: string
  minVisualFontPx: number
  results: FontCheckResult[]
}

const scenarioOptions: Array<{
  id: ScenarioId
  name: string
  description: string
}> = [
  {
    id: 'ipad-820x1180',
    name: 'iPad 820 × 1180',
    description: '作为苹果平板视觉基准',
  },
  {
    id: 'ipad-768x1024',
    name: 'iPad 768 × 1024',
    description: '旧款 iPad 逻辑分辨率',
  },
  {
    id: 'ipad-810x1080',
    name: 'iPad 810 × 1080',
    description: '10.2 英寸 iPad 基准',
  },
  {
    id: 'android-tablet-800x1280',
    name: 'Android 800 × 1280',
    description: '主流 Android 平板档',
  },
  {
    id: 'android-tablet-640x876',
    name: 'Android 640 × 876',
    description: 'X3、X6、A7 等窄屏学习机档',
  },
  {
    id: 'android-tablet-800x1088',
    name: 'Android 800 × 1088',
    description: '中等高度平板档',
  },
  {
    id: 'android-tablet-800x1164',
    name: 'Android 800 × 1164',
    description: '高屏占比学习机档',
  },
  {
    id: 'android-tablet-720x1100',
    name: 'Android 720 × 1100',
    description: '华为平板逻辑分辨率档',
  },
  {
    id: 'android-tablet-920x1400',
    name: 'Android 920 × 1400',
    description: '大屏 Android 平板档',
  },
]

const diagnosticConfig = reactive({
  url: 'https://m1-test.dev.ihuman.com/h5/essay/writing/index/miniGames/wordPair?grade=grade1&term=up&major=2&sub=1',
  minVisualFontPx: 16,
  waitMs: 2500,
  annotate: true,
  simulateLegacyAndroidWebView: true,
  scenarioIds: scenarioOptions.map((scenario) => scenario.id),
})
const running = ref(false)
const response = ref<FontCheckResponse | null>(null)
const expandedScenarioId = ref<string | null>(null)

onMounted(() => {
  void ElMessageBox.alert('工具尚未验证完成。', '提示', {
    confirmButtonText: '我知道了',
    type: 'warning',
    showClose: false,
    closeOnClickModal: false,
    closeOnPressEscape: false,
  })
})

const totalIssues = computed(
  () =>
    response.value?.results.reduce(
      (total, result) => total + (result.metrics?.issueCount ?? 0),
      0,
    ) ?? 0,
)
function severityClass(result: FontCheckResult): string {
  if (result.error || !result.metrics) return 'failed'
  if (result.metrics.issueCount === 0) return 'passed'
  if (result.metrics.visualViewportScale < 0.5) return 'critical'
  return 'warning'
}

function severityLabel(result: FontCheckResult): string {
  const severity = severityClass(result)
  if (severity === 'failed') return '检测失败'
  if (severity === 'passed') return '未发现小字'
  if (severity === 'critical') return '严重缩小'
  return `${result.metrics?.issueCount ?? 0} 处偏小`
}

async function startFontCheck(): Promise<void> {
  if (running.value) return
  if (diagnosticConfig.scenarioIds.length === 0) {
    ElMessage.warning('请至少选择一个检测场景')
    return
  }
  try {
    new URL(diagnosticConfig.url)
  } catch {
    ElMessage.error('请输入完整有效的页面 URL')
    return
  }

  running.value = true
  response.value = null
  expandedScenarioId.value = null
  try {
    const request = await fetch('/api/font-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(diagnosticConfig),
    })
    const payload = (await request.json()) as FontCheckResponse | { error?: string }
    if (!request.ok || !('results' in payload)) {
      throw new Error('error' in payload ? payload.error : '字体检查请求失败')
    }
    response.value = payload
    expandedScenarioId.value = payload.results[0]?.scenarioId ?? null
    ElMessage.success('字体检查完成')
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '字体检查失败')
  } finally {
    running.value = false
  }
}

function toggleIssues(scenarioId: string): void {
  expandedScenarioId.value =
    expandedScenarioId.value === scenarioId ? null : scenarioId
}
</script>

<template>
  <main class="page-shell">
    <AppHeader />

    <section class="intro-card surface-card">
      <div>
        <span class="eyebrow">FONT INSPECTOR</span>
        <h2>字体检查</h2>
        <p>
          跑完主页同款的全部平板逻辑分辨率，并额外模拟旧 Android WebView 不支持容器查询单位时的 CSS 失效结果。
        </p>
      </div>
      <div class="scope-note">
        <strong>模拟边界</strong>
        <span>可发现 cq 字号声明失效后退回 16px 的小字；系统 textZoom 等原生设置仍需真机校验。</span>
      </div>
    </section>

    <section class="control-card surface-card">
      <div class="control-grid">
        <label class="field field-url">
          <span>目标页面 URL</span>
          <el-input
            v-model="diagnosticConfig.url"
            size="large"
            placeholder="https://example.com/page"
            clearable
          />
        </label>

        <label class="field">
          <span>最小视觉字号</span>
          <el-input-number
            v-model="diagnosticConfig.minVisualFontPx"
            :min="8"
            :max="40"
            :step="1"
            controls-position="right"
          />
        </label>

        <label class="field">
          <span>页面额外等待</span>
          <el-select v-model="diagnosticConfig.waitMs">
            <el-option label="不额外等待" :value="0" />
            <el-option label="等待 1.5 秒" :value="1500" />
            <el-option label="等待 2.5 秒" :value="2500" />
            <el-option label="等待 5 秒" :value="5000" />
          </el-select>
        </label>

        <label class="field switch-field">
          <span>截图标注</span>
          <el-switch v-model="diagnosticConfig.annotate" active-text="标红偏小文本" />
        </label>

        <label class="field switch-field">
          <span>旧 Android WebView</span>
          <el-switch
            v-model="diagnosticConfig.simulateLegacyAndroidWebView"
            active-text="模拟 cq 单位失效"
          />
        </label>
      </div>

      <div class="scenario-section">
        <div class="scenario-heading">
          <strong>检测场景</strong>
          <span>默认选中主页中的 3 个 iPad 与 6 个 Android 平板档</span>
        </div>
        <el-checkbox-group v-model="diagnosticConfig.scenarioIds" class="scenario-grid">
          <el-checkbox
            v-for="scenario in scenarioOptions"
            :key="scenario.id"
            :value="scenario.id"
            class="scenario-option"
          >
            <span>
              <strong>{{ scenario.name }}</strong>
              <small>{{ scenario.description }}</small>
            </span>
          </el-checkbox>
        </el-checkbox-group>
      </div>

      <footer class="control-footer">
        <p>
          红框表示视觉字号低于 {{ diagnosticConfig.minVisualFontPx }}px；旧 WebView 会为每个 Android
          视口追加一张兼容性截图。
        </p>
        <el-button type="primary" size="large" :loading="running" @click="startFontCheck">
          {{ running ? '正在启动多设备 Chromium…' : '开始字体检查' }}
        </el-button>
      </footer>
    </section>

    <section v-if="response" class="result-section">
      <div class="section-heading">
        <div>
          <h2>检测结果</h2>
          <p>{{ response.results.length }} 个场景，共发现 {{ totalIssues }} 处偏小文本</p>
        </div>
        <code>{{ response.runId }}</code>
      </div>

      <div class="result-grid">
        <article
          v-for="result in response.results"
          :key="result.scenarioId"
          class="result-card surface-card"
        >
          <header>
            <div>
              <span class="scenario-kind" :class="result.kind">
                {{
                  result.kind === 'baseline'
                    ? '苹果基准'
                    : result.kind === 'compatibility'
                      ? '旧 WebView'
                      : '安卓平板'
                }}
              </span>
              <h3>{{ result.scenarioName }}</h3>
            </div>
            <span class="severity-badge" :class="severityClass(result)">
              {{ severityLabel(result) }}
            </span>
          </header>

          <div v-if="result.metrics" class="metric-grid">
            <div>
              <span>视觉缩放</span>
              <strong>{{ result.metrics.visualViewportScale.toFixed(3) }}</strong>
            </div>
            <div>
              <span>布局宽度</span>
              <strong>{{ result.metrics.clientWidth }}px</strong>
            </div>
            <div>
              <span>outerWidth</span>
              <strong>{{ result.metrics.outerWidth }}px</strong>
            </div>
            <div>
              <span>text-size-adjust</span>
              <strong>{{ result.metrics.textSizeAdjust }}</strong>
            </div>
            <div>
              <span>cq 字号失效</span>
              <strong>{{ result.metrics.affectedContainerUnitTextCount }} 个节点</strong>
            </div>
          </div>

          <p v-if="result.error" class="error-copy">{{ result.error }}</p>
          <a
            v-else
            class="screenshot-link"
            :href="result.screenshotUrl"
            target="_blank"
            rel="noreferrer"
          >
            <img :src="result.screenshotUrl" :alt="`${result.scenarioName} 字体检查截图`" />
            <span>点击查看原尺寸标注截图</span>
          </a>

          <footer v-if="result.metrics">
            <a :href="result.originalScreenshotUrl" target="_blank" rel="noreferrer">
              查看无标注原图
            </a>
            <button type="button" @click="toggleIssues(result.scenarioId)">
              {{
                expandedScenarioId === result.scenarioId
                  ? '收起问题节点'
                  : `查看问题节点（${result.metrics.issueCount}）`
              }}
            </button>
          </footer>

          <div
            v-if="result.metrics && expandedScenarioId === result.scenarioId"
            class="issue-list"
          >
            <div
              v-for="issue in result.metrics.issues.slice(0, 20)"
              :key="`${issue.selector}-${issue.text}`"
              class="issue-row"
            >
              <div>
                <strong>{{ issue.visualFontPx }}px</strong>
                <span>
                  模拟 CSS {{ issue.simulatedCssFontPx }}px / 原始 {{ issue.cssFontPx }}px
                </span>
              </div>
              <p>{{ issue.text || '无文本摘要' }}</p>
              <code>{{ issue.selector }}</code>
            </div>
            <p v-if="result.metrics.issueCount === 0" class="empty-issues">
              当前阈值下未发现可见的小字号文本。
            </p>
          </div>
        </article>
      </div>
    </section>
  </main>
</template>

<style scoped>
.page-shell {
  width: min(1440px, calc(100% - 48px));
  margin: 0 auto;
  padding-bottom: 72px;
}

.intro-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  align-items: center;
  gap: 32px;
  padding: 24px 28px;
  background:
    radial-gradient(circle at 90% 10%, rgb(101 88 232 / 12%), transparent 34%),
    var(--color-surface);
}

.eyebrow {
  color: var(--color-primary-dark);
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.16em;
}

.intro-card h2 {
  margin: 6px 0 5px;
  font-size: 24px;
}

.intro-card p,
.scope-note span {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 13px;
  line-height: 1.7;
}

.scope-note {
  display: grid;
  gap: 5px;
  padding: 14px 16px;
  border: 1px solid var(--color-primary-border);
  border-radius: 12px;
  background: var(--color-primary-soft);
}

.scope-note strong {
  color: var(--color-primary-dark);
  font-size: 12px;
}

.control-card {
  margin-top: 14px;
  padding: 22px;
}

.control-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) repeat(4, 160px);
  gap: 16px;
}

.field {
  display: grid;
  align-content: start;
  gap: 8px;
  min-width: 0;
}

.field > span,
.scenario-heading strong {
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 700;
}

.field :deep(.el-input-number),
.field :deep(.el-select) {
  width: 100%;
}

.switch-field {
  padding-top: 1px;
}

.switch-field :deep(.el-switch) {
  min-height: 40px;
}

.scenario-section {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 1px solid var(--color-border-light);
}

.scenario-heading {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 10px;
}

.scenario-heading span,
.control-footer p {
  color: var(--color-text-muted);
  font-size: 12px;
}

.scenario-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.scenario-option {
  width: 100%;
  height: auto;
  margin: 0;
  padding: 13px 14px;
  border: 1px solid var(--color-border);
  border-radius: 11px;
  background: var(--color-surface-subtle);
}

.scenario-option:has(.el-checkbox__input.is-checked) {
  border-color: var(--color-primary-border);
  background: var(--color-primary-soft);
}

.scenario-option :deep(.el-checkbox__label) {
  min-width: 0;
  white-space: normal;
}

.scenario-option span {
  display: grid;
  gap: 3px;
}

.scenario-option strong {
  color: var(--color-text-strong);
  font-size: 13px;
}

.scenario-option small {
  color: var(--color-text-muted);
  font-size: 11px;
}

.control-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-top: 20px;
}

.control-footer p {
  margin: 0;
}

.result-section {
  margin-top: 28px;
}

.section-heading {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 12px;
}

.section-heading h2 {
  margin: 0;
  font-size: 18px;
}

.section-heading p {
  margin: 5px 0 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.section-heading code {
  color: var(--color-text-muted);
  font-size: 11px;
}

.result-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}

.result-card {
  min-width: 0;
  padding: 18px;
}

.result-card > header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.result-card h3 {
  margin: 7px 0 0;
  font-size: 16px;
}

.scenario-kind,
.severity-badge {
  display: inline-flex;
  padding: 4px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 750;
}

.scenario-kind.baseline {
  color: #286596;
  background: #eaf5ff;
}

.scenario-kind.android {
  color: #24714e;
  background: #e8f8ef;
}

.scenario-kind.compatibility {
  color: #9b5c09;
  background: #fff3d8;
}

.severity-badge.passed {
  color: var(--color-success);
  background: var(--color-success-soft);
}

.severity-badge.warning {
  color: #9b5c09;
  background: #fff3d8;
}

.severity-badge.critical,
.severity-badge.failed {
  color: var(--color-danger);
  background: var(--color-danger-soft);
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 7px;
  margin: 14px 0;
}

.metric-grid div {
  min-width: 0;
  padding: 9px 10px;
  border-radius: 9px;
  background: var(--color-surface-subtle);
}

.metric-grid span,
.metric-grid strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.metric-grid span {
  color: var(--color-text-muted);
  font-size: 10px;
}

.metric-grid strong {
  margin-top: 3px;
  font-size: 13px;
}

.screenshot-link {
  display: block;
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  color: var(--color-text-secondary);
  background: #e9ebf0;
  text-decoration: none;
}

.screenshot-link img {
  display: block;
  width: 100%;
  height: 420px;
  object-fit: contain;
}

.screenshot-link span {
  display: block;
  padding: 8px 12px;
  border-top: 1px solid var(--color-border);
  background: var(--color-surface);
  font-size: 11px;
  text-align: center;
}

.result-card > footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin-top: 11px;
}

.result-card > footer a,
.result-card > footer button {
  color: var(--color-primary-dark);
  font-family: inherit;
  font-size: 11px;
  font-weight: 650;
  line-height: 1.4;
  text-decoration: none;
}

.result-card > footer button {
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
}

.issue-list {
  display: grid;
  gap: 7px;
  max-height: 360px;
  margin-top: 13px;
  padding-top: 13px;
  border-top: 1px solid var(--color-border-light);
  overflow: auto;
}

.issue-row {
  display: grid;
  grid-template-columns: 86px minmax(0, 1fr);
  gap: 5px 10px;
  padding: 9px 10px;
  border-radius: 8px;
  background: var(--color-surface-subtle);
}

.issue-row > div {
  display: flex;
  align-items: baseline;
  gap: 4px;
}

.issue-row strong {
  color: var(--color-danger);
  font-size: 13px;
}

.issue-row span,
.issue-row code {
  color: var(--color-text-muted);
  font-size: 10px;
}

.issue-row p {
  overflow: hidden;
  margin: 0;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.issue-row code {
  grid-column: 2;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.error-copy,
.empty-issues {
  padding: 18px;
  color: var(--color-danger);
  background: var(--color-danger-soft);
  border-radius: 10px;
  font-size: 12px;
}

@media (max-width: 980px) {
  .intro-card {
    grid-template-columns: 1fr;
  }

  .control-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .field-url {
    grid-column: 1 / -1;
  }

  .scenario-grid,
  .result-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .page-shell {
    width: min(100% - 24px, 1440px);
  }

  .control-grid,
  .scenario-grid,
  .result-grid {
    grid-template-columns: 1fr;
  }

  .control-footer,
  .section-heading {
    align-items: stretch;
    flex-direction: column;
  }

  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
