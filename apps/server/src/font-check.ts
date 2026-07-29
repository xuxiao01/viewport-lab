import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FastifyInstance } from 'fastify'
import { chromium, devices } from 'playwright'

const rootDir = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const runsDir = resolve(rootDir, 'data/runs')
const scenarioIds = [
  'ipad-820x1180',
  'ipad-768x1024',
  'ipad-810x1080',
  'android-tablet-800x1280',
  'android-tablet-640x876',
  'android-tablet-800x1088',
  'android-tablet-800x1164',
  'android-tablet-720x1100',
  'android-tablet-920x1400',
] as const

type FontCheckScenarioId = (typeof scenarioIds)[number]

interface FontCheckRequest {
  url: string
  minVisualFontPx: number
  waitMs: number
  annotate: boolean
  simulateLegacyAndroidWebView: boolean
  scenarioIds: FontCheckScenarioId[]
}

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

interface ScenarioDefinition {
  id: FontCheckScenarioId
  name: string
  kind: FontCheckResult['kind']
  viewport: { width: number; height: number }
  screen: { width: number; height: number }
  userAgent: string
  platform: 'ipad' | 'android'
}

const scenarioDefinitions: ScenarioDefinition[] = [
  {
    id: 'ipad-820x1180',
    name: 'iPad 820 × 1180 基准',
    kind: 'baseline',
    viewport: { width: 820, height: 1180 },
    screen: { width: 820, height: 1180 },
    userAgent: devices['iPad (gen 7)'].userAgent,
    platform: 'ipad',
  },
  {
    id: 'ipad-768x1024',
    name: 'iPad 768 × 1024 基准',
    kind: 'baseline',
    viewport: { width: 768, height: 1024 },
    screen: { width: 768, height: 1024 },
    userAgent: devices['iPad (gen 5)'].userAgent,
    platform: 'ipad',
  },
  {
    id: 'ipad-810x1080',
    name: 'iPad 810 × 1080 基准',
    kind: 'baseline',
    viewport: { width: 810, height: 1080 },
    screen: { width: 810, height: 1080 },
    userAgent: devices['iPad (gen 7)'].userAgent,
    platform: 'ipad',
  },
  {
    id: 'android-tablet-800x1280',
    name: 'Android 平板 800 × 1280',
    kind: 'android',
    viewport: { width: 800, height: 1280 },
    screen: { width: 800, height: 1280 },
    userAgent: devices['Nexus 10'].userAgent,
    platform: 'android',
  },
  {
    id: 'android-tablet-640x876',
    name: 'Android 学习机 640 × 876',
    kind: 'android',
    viewport: { width: 640, height: 876 },
    screen: { width: 640, height: 876 },
    userAgent: (devices['Galaxy Tab S4'] ?? devices['Nexus 10']).userAgent,
    platform: 'android',
  },
  {
    id: 'android-tablet-800x1088',
    name: 'Android 平板 800 × 1088',
    kind: 'android',
    viewport: { width: 800, height: 1088 },
    screen: { width: 800, height: 1088 },
    userAgent: devices['Nexus 10'].userAgent,
    platform: 'android',
  },
  {
    id: 'android-tablet-800x1164',
    name: 'Android 平板 800 × 1164',
    kind: 'android',
    viewport: { width: 800, height: 1164 },
    screen: { width: 800, height: 1164 },
    userAgent: devices['Nexus 10'].userAgent,
    platform: 'android',
  },
  {
    id: 'android-tablet-720x1100',
    name: 'Android 平板 720 × 1100',
    kind: 'android',
    viewport: { width: 720, height: 1100 },
    screen: { width: 720, height: 1100 },
    userAgent: (devices['Galaxy Tab S4'] ?? devices['Nexus 10']).userAgent,
    platform: 'android',
  },
  {
    id: 'android-tablet-920x1400',
    name: 'Android 平板 920 × 1400',
    kind: 'android',
    viewport: { width: 920, height: 1400 },
    screen: { width: 920, height: 1400 },
    userAgent: (devices['Galaxy Z Fold 6'] ?? devices['Nexus 10']).userAgent,
    platform: 'android',
  },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function parseRequest(value: unknown): FontCheckRequest | null {
  if (!isRecord(value)) return null
  const {
    url,
    minVisualFontPx,
    waitMs,
    annotate,
    simulateLegacyAndroidWebView,
    scenarioIds: requestedScenarioIds,
  } = value
  if (
    typeof url !== 'string' ||
    typeof minVisualFontPx !== 'number' ||
    !Number.isFinite(minVisualFontPx) ||
    minVisualFontPx < 8 ||
    minVisualFontPx > 40 ||
    typeof waitMs !== 'number' ||
    !Number.isInteger(waitMs) ||
    waitMs < 0 ||
    waitMs > 15_000 ||
    typeof annotate !== 'boolean' ||
    typeof simulateLegacyAndroidWebView !== 'boolean' ||
    !Array.isArray(requestedScenarioIds) ||
    requestedScenarioIds.length === 0 ||
    !requestedScenarioIds.every(
      (id) => typeof id === 'string' && scenarioIds.includes(id as FontCheckScenarioId),
    )
  ) {
    return null
  }
  try {
    const parsedUrl = new URL(url)
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') return null
  } catch {
    return null
  }
  return {
    url,
    minVisualFontPx,
    waitMs,
    annotate,
    simulateLegacyAndroidWebView,
    scenarioIds: [...new Set(requestedScenarioIds as FontCheckScenarioId[])],
  }
}

async function waitForPage(page: import('playwright').Page, waitMs: number): Promise<void> {
  try {
    await page.waitForLoadState('networkidle', { timeout: 8_000 })
  } catch {
    // 持续轮询或埋点请求不应阻断字体检查。
  }
  try {
    await page.evaluate(() => document.fonts.ready)
  } catch {
    // 页面导航或字体 API 不可用时继续保留截图结果。
  }
  if (waitMs > 0) await page.waitForTimeout(waitMs)
}

async function simulateLegacyContainerUnits(
  page: import('playwright').Page,
): Promise<number> {
  return page.evaluate(() => {
    const affectedElements = new Set<HTMLElement>()
    const ruleStack: CSSRule[] = []
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        ruleStack.push(...Array.from(sheet.cssRules))
      } catch {
        // 跨域样式表不可读时跳过。
      }
    }
    while (ruleStack.length > 0) {
      const rule = ruleStack.pop()
      if (!rule) continue
      if ('cssRules' in rule) {
        try {
          ruleStack.push(...Array.from((rule as CSSGroupingRule).cssRules))
        } catch {
          // 跨域或浏览器内部样式表不可读时跳过。
        }
      }
      if (!(rule instanceof CSSStyleRule)) continue
      const fontSize = rule.style.getPropertyValue('font-size')
      if (!/\d(?:\.\d+)?cq(?:w|h|min|max|i|b)\b/i.test(fontSize)) continue
      try {
        document.querySelectorAll<HTMLElement>(rule.selectorText).forEach((element) => {
          if (!element.dataset.viewportLabOriginalFontPx) {
            element.dataset.viewportLabOriginalFontPx = String(
              Number.parseFloat(getComputedStyle(element).fontSize),
            )
          }
          affectedElements.add(element)
        })
      } catch {
        // 伪元素等不能用于 querySelectorAll 的选择器不影响检测继续。
      }
    }
    document
      .querySelectorAll<HTMLElement>('.word-pair__card-text')
      .forEach((element) => {
        if (!element.dataset.viewportLabOriginalFontPx) {
          element.dataset.viewportLabOriginalFontPx = String(
            Number.parseFloat(getComputedStyle(element).fontSize),
          )
        }
        affectedElements.add(element)
      })
    for (const element of affectedElements) {
      element.style.setProperty('font-size', 'unset', 'important')
      element.style.setProperty('line-height', 'normal', 'important')
    }
    return affectedElements.size
  })
}

async function inspectFonts(
  page: import('playwright').Page,
  minVisualFontPx: number,
  annotate: boolean,
  scenarioName: string,
  compatibilityMode: FontCheckMetrics['compatibilityMode'],
  affectedContainerUnitTextCount: number,
): Promise<FontCheckMetrics> {
  return page.evaluate(
    ({ threshold, shouldAnnotate, label, mode, affectedCount }) => {
      document.getElementById('__viewport_lab_font_check_legend__')?.remove()
      document
        .querySelectorAll<HTMLElement>('[data-viewport-lab-font-issue]')
        .forEach((element) => {
          element.style.removeProperty('outline')
          element.style.removeProperty('outline-offset')
          element.removeAttribute('data-viewport-lab-font-issue')
        })

      const viewportContent =
        document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? ''
      const visualScale = window.visualViewport?.scale ?? 1
      const ignoredTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH'])
      const issues: FontIssue[] = []
      let inspectedTextCount = 0

      const elements = Array.from(document.body?.querySelectorAll<HTMLElement>('*') ?? [])
      for (const element of elements) {
        if (ignoredTags.has(element.tagName)) continue
        const ownText = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent?.replace(/\s+/g, ' ').trim() ?? '')
          .filter(Boolean)
          .join(' ')
        if (!ownText) continue

        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        const visible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          Number(style.opacity) > 0 &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.right > 0 &&
          rect.top < innerHeight &&
          rect.left < innerWidth
        if (!visible) continue

        const simulatedCssFontPx = Number.parseFloat(style.fontSize)
        if (!Number.isFinite(simulatedCssFontPx) || simulatedCssFontPx <= 0) continue
        const originalCssFontPx = Number(
          element.dataset.viewportLabOriginalFontPx ?? simulatedCssFontPx,
        )
        inspectedTextCount += 1
        const visualFontPx = simulatedCssFontPx * visualScale
        if (visualFontPx >= threshold) continue

        let selector = ''
        if (element.id) {
          selector = `#${CSS.escape(element.id)}`
        } else {
          const parts: string[] = []
          let current: Element | null = element
          while (current && current !== document.body && parts.length < 4) {
            let part = current.tagName.toLowerCase()
            const className = Array.from(current.classList)
              .filter((name) => !name.startsWith('__viewport_lab'))
              .slice(0, 2)
              .map((name) => `.${CSS.escape(name)}`)
              .join('')
            part += className
            if (!className && current.parentElement) {
              const currentTagName = current.tagName
              const siblings = Array.from(current.parentElement.children).filter(
                (item) => item.tagName === currentTagName,
              )
              if (siblings.length > 1) {
                part += `:nth-of-type(${siblings.indexOf(current) + 1})`
              }
            }
            parts.unshift(part)
            current = current.parentElement
          }
          selector = parts.join(' > ')
        }

        issues.push({
          selector,
          text: ownText.slice(0, 80),
          cssFontPx: Number(originalCssFontPx.toFixed(2)),
          simulatedCssFontPx: Number(simulatedCssFontPx.toFixed(2)),
          visualFontPx: Number(visualFontPx.toFixed(2)),
          estimatedDeviceFontPx: Number(
            (visualFontPx * window.devicePixelRatio).toFixed(2),
          ),
          fontFamily: style.fontFamily,
          fontWeight: style.fontWeight,
          rect: {
            x: Number(rect.x.toFixed(2)),
            y: Number(rect.y.toFixed(2)),
            width: Number(rect.width.toFixed(2)),
            height: Number(rect.height.toFixed(2)),
          },
        })
      }

      issues.sort((left, right) => left.visualFontPx - right.visualFontPx)
      const limitedIssues = issues.slice(0, 100)
      if (shouldAnnotate) {
        for (const issue of limitedIssues) {
          const element = document.querySelector<HTMLElement>(issue.selector)
          if (!element) continue
          element.dataset.viewportLabFontIssue = String(issue.visualFontPx)
          element.style.setProperty('outline', '3px solid #ff334b', 'important')
          element.style.setProperty('outline-offset', '2px', 'important')
        }

        const legend = document.createElement('aside')
        legend.id = '__viewport_lab_font_check_legend__'
        legend.style.cssText = [
          'position:fixed',
          'z-index:2147483647',
          'left:16px',
          'bottom:16px',
          'max-width:min(520px,calc(100vw - 32px))',
          'padding:12px 16px',
          'border:2px solid #ff334b',
          'border-radius:10px',
          'background:rgba(255,255,255,.96)',
          'box-shadow:0 6px 24px rgba(0,0,0,.2)',
          'color:#1f2430',
          'font:600 14px/1.45 system-ui,sans-serif',
          'text-align:left',
        ].join(';')
        legend.textContent = `${label}｜页面缩放 ${visualScale.toFixed(3)}｜${mode === 'legacy-container-units' ? `旧 WebView：${affectedCount} 个 cq 字号声明失效` : '现代内核'}｜低于 ${threshold}px：${issues.length} 处`
        document.body.appendChild(legend)
      }

      return {
        userAgent: navigator.userAgent,
        devicePixelRatio,
        innerWidth,
        innerHeight,
        outerWidth,
        screenWidth: screen.width,
        clientWidth: document.documentElement.clientWidth,
        visualViewportWidth: window.visualViewport?.width ?? null,
        visualViewportScale: Number(visualScale.toFixed(6)),
        viewportContent,
        textSizeAdjust: getComputedStyle(document.documentElement).webkitTextSizeAdjust,
        containerUnitsSupported: CSS.supports('font-size', '72cqmin'),
        compatibilityMode: mode,
        affectedContainerUnitTextCount: affectedCount,
        inspectedTextCount,
        issueCount: issues.length,
        issues: limitedIssues,
      }
    },
    {
      threshold: minVisualFontPx,
      shouldAnnotate: annotate,
      label: scenarioName,
      mode: compatibilityMode,
      affectedCount: affectedContainerUnitTextCount,
    },
  )
}

export async function registerFontCheck(app: FastifyInstance): Promise<void> {
  app.post<{ Body: unknown; Reply: FontCheckResponse | { error: string } }>(
    '/api/font-check',
    async (request, reply) => {
      const parsed = parseRequest(request.body)
      if (!parsed) return reply.code(400).send({ error: 'Invalid font check request' })

      const runId = `font-check-${randomUUID()}`
      const outputDir = resolve(runsDir, runId)
      await mkdir(outputDir, { recursive: true })
      const selectedDefinitions = scenarioDefinitions.filter((scenario) =>
        parsed.scenarioIds.includes(scenario.id),
      )
      const selectedScenarios = selectedDefinitions.flatMap((scenario) => [
        { ...scenario, compatibilityMode: 'normal' as const },
        ...(parsed.simulateLegacyAndroidWebView && scenario.platform === 'android'
          ? [{ ...scenario, compatibilityMode: 'legacy-container-units' as const }]
          : []),
      ])
      const browser = await chromium.launch()
      const results: FontCheckResult[] = []

      try {
        for (const scenario of selectedScenarios) {
          const context = await browser.newContext({
            viewport: scenario.viewport,
            screen: scenario.screen,
            deviceScaleFactor: 2,
            isMobile: true,
            hasTouch: true,
            userAgent: scenario.userAgent,
          })
          const page = await context.newPage()
          page.setDefaultNavigationTimeout(30_000)
          page.setDefaultTimeout(15_000)
          const resultId =
            scenario.compatibilityMode === 'legacy-container-units'
              ? `${scenario.id}-legacy-webview`
              : scenario.id
          const scenarioName =
            scenario.compatibilityMode === 'legacy-container-units'
              ? `${scenario.name} · 旧 WebView`
              : scenario.name
          const originalName = `${resultId}-original.png`
          const annotatedName = `${resultId}-annotated.png`

          try {
            const response = await page.goto(parsed.url, { waitUntil: 'domcontentloaded' })
            await waitForPage(page, parsed.waitMs)
            const affectedContainerUnitTextCount =
              scenario.compatibilityMode === 'legacy-container-units'
                ? await simulateLegacyContainerUnits(page)
                : 0
            await page.screenshot({
              path: resolve(outputDir, originalName),
              fullPage: false,
            })
            const metrics = await inspectFonts(
              page,
              parsed.minVisualFontPx,
              parsed.annotate,
              scenarioName,
              scenario.compatibilityMode,
              affectedContainerUnitTextCount,
            )
            await page.screenshot({
              path: resolve(outputDir, annotatedName),
              fullPage: false,
            })
            results.push({
              scenarioId: resultId,
              scenarioName,
              kind:
                scenario.compatibilityMode === 'legacy-container-units'
                  ? 'compatibility'
                  : scenario.kind,
              viewport: scenario.viewport,
              httpStatus: response?.status() ?? null,
              finalUrl: page.url(),
              screenshotUrl: `/outputs/${runId}/${annotatedName}`,
              originalScreenshotUrl: `/outputs/${runId}/${originalName}`,
              metrics,
              error: null,
            })
          } catch (error) {
            results.push({
              scenarioId: resultId,
              scenarioName,
              kind:
                scenario.compatibilityMode === 'legacy-container-units'
                  ? 'compatibility'
                  : scenario.kind,
              viewport: scenario.viewport,
              httpStatus: null,
              finalUrl: page.url(),
              screenshotUrl: '',
              originalScreenshotUrl: '',
              metrics: null,
              error: error instanceof Error ? error.message : 'Font check failed',
            })
          } finally {
            await context.close()
          }
        }
      } finally {
        await browser.close()
      }

      return reply.send({
        runId,
        createdAt: new Date().toISOString(),
        url: parsed.url,
        minVisualFontPx: parsed.minVisualFontPx,
        results,
      })
    },
  )
}
