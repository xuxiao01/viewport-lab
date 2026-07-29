import type { AgentPageState, AgentWaitResult } from '@viewport-lab/shared'

import type { AgentCliBridge } from './cli-bridge.js'

export const AGENT_READY_TIMEOUT_MS = 15_000
const DOM_STABILITY_SOFT_TIMEOUT_MS = 5_000

interface PreparedPageState extends AgentPageState {
  preparedAt: number
}

interface ReadinessPayload {
  wait: AgentWaitResult
  page: AgentPageState
}

export async function preparePageObservation(
  bridge: AgentCliBridge,
  session: string,
): Promise<PreparedPageState> {
  const result = await bridge.runCode(session, PREPARE_SCRIPT)
  if (!result.ok) throw new Error(result.error ?? '页面观察器初始化失败')
  return parseJson<PreparedPageState>(result.output, '页面观察器返回无效数据')
}

export async function waitForPageReady(
  bridge: AgentCliBridge,
  session: string,
  command: string,
  before: PreparedPageState | null,
  timeoutMs = AGENT_READY_TIMEOUT_MS,
): Promise<ReadinessPayload> {
  const script = createWaitScript(command, before?.url ?? null, timeoutMs)
  const startedAt = Date.now()
  const result = await bridge.runCode(session, script)
  if (result.ok) return parseJson<ReadinessPayload>(result.output, '页面等待返回无效数据')

  return {
    wait: {
      status: 'timed_out',
      reason: 'observer_error',
      elapsedMs: Date.now() - startedAt,
      signals: {
        navigation: signal('error', result.error),
        network: signal('error', result.error),
        dom: signal('error', result.error),
        fonts: signal('error', result.error),
        images: signal('error', result.error),
        paint: signal('error', result.error),
      },
    },
    page: { url: before?.url ?? '', title: before?.title ?? '' },
  }
}

function signal(status: 'error', detail: string | null) {
  return { status, detail }
}

function parseJson<T>(output: string, message: string): T {
  try {
    return JSON.parse(output) as T
  } catch {
    throw new Error(`${message}: ${output.slice(0, 500)}`)
  }
}

const PREPARE_SCRIPT = String.raw`async (page) => {
  if (!page.__viewportLabReadiness) {
    const state = { inflight: new Set(), lastNetworkActivity: Date.now() }
    const ignored = new Set(['websocket', 'eventsource'])
    page.on('request', request => {
      if (ignored.has(request.resourceType())) return
      state.inflight.add(request)
      state.lastNetworkActivity = Date.now()
    })
    const settle = request => {
      if (!state.inflight.delete(request)) return
      state.lastNetworkActivity = Date.now()
    }
    page.on('requestfinished', settle)
    page.on('requestfailed', settle)
    page.__viewportLabReadiness = state
  }
  return { url: page.url(), title: await page.title(), preparedAt: Date.now() }
}`

function createWaitScript(command: string, previousUrl: string | null, timeoutMs: number): string {
  return String.raw`async (page) => {
    const startedAt = Date.now()
    const deadline = startedAt + ${Math.max(1, timeoutMs)}
    const command = ${JSON.stringify(command)}
    const previousUrl = ${JSON.stringify(previousUrl)}
    const domSoftTimeoutMs = ${DOM_STABILITY_SOFT_TIMEOUT_MS}
    const navigationCommand = ['goto', 'go-back', 'go-forward', 'reload'].includes(command)
    const state = page.__viewportLabReadiness || { inflight: new Set(), lastNetworkActivity: Date.now() }
    page.__viewportLabReadiness = state
    const signal = (status, detail = null) => ({ status, detail })
    const signals = {
      navigation: signal(navigationCommand ? 'pending' : 'skipped', navigationCommand ? 'waiting_for_url_or_load' : 'not_navigation'),
      network: signal('pending', 'waiting_for_500ms_quiet'),
      dom: signal('pending', 'waiting_for_700ms_quiet'),
      fonts: signal('pending', 'waiting_for_fonts'),
      images: signal('pending', 'waiting_for_visible_images'),
      paint: signal('pending', 'waiting_for_two_frames'),
    }

    await page.evaluate(() => {
      const key = '__viewportLabDomObserver'
      if (window[key]) window[key].observer.disconnect()
      const holder = { lastMutation: Date.now(), observer: null }
      holder.observer = new MutationObserver(() => { holder.lastMutation = Date.now() })
      holder.observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      })
      window[key] = holder
    }).catch(() => undefined)

    let loadReady = false
    let networkIdleSoft = false
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout: Math.min(2000, Math.max(1, deadline - Date.now())) })
        .then(() => { loadReady = true })
        .catch(() => undefined),
      page.waitForLoadState('networkidle', { timeout: Math.min(1000, Math.max(1, deadline - Date.now())) })
        .then(() => { networkIdleSoft = true })
        .catch(() => undefined),
    ])

    while (Date.now() < deadline) {
      const now = Date.now()
      const currentUrl = page.url()
      if (navigationCommand && (currentUrl !== previousUrl || loadReady)) {
        signals.navigation = signal('ready', currentUrl !== previousUrl ? 'url_changed' : 'domcontentloaded')
      }
      if (state.inflight.size === 0 && now - state.lastNetworkActivity >= 500) {
        signals.network = signal('ready', networkIdleSoft ? 'network_quiet_and_networkidle' : 'network_quiet')
      }

      const browserState = await page.evaluate(async () => {
        const domHolder = window.__viewportLabDomObserver
        const visibleImages = Array.from(document.images).filter(image => {
          const rect = image.getBoundingClientRect()
          const style = getComputedStyle(image)
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
            rect.top < innerHeight && rect.left < innerWidth && style.visibility !== 'hidden' && style.display !== 'none'
        })
        await Promise.all(visibleImages.map(image => image.complete && image.naturalWidth > 0
          ? Promise.race([
              image.decode().catch(() => undefined),
              new Promise(resolve => setTimeout(resolve, 200)),
            ])
          : Promise.resolve()))
        const fontsReady = !document.fonts || document.fonts.status === 'loaded'
        const imagesReady = visibleImages.every(image => image.complete)
        const lastMutation = domHolder ? domHolder.lastMutation : Date.now()
        return { fontsReady, imagesReady, lastMutation }
      }).catch(() => ({ fontsReady: false, imagesReady: false, lastMutation: Date.now() }))

      if (now - browserState.lastMutation >= 700) signals.dom = signal('ready', 'dom_quiet')
      else if (now - startedAt >= domSoftTimeoutMs) signals.dom = signal('skipped', 'dom_still_changing_soft_limit')
      if (browserState.fontsReady) signals.fonts = signal('ready', 'fonts_loaded')
      if (browserState.imagesReady) signals.images = signal('ready', 'visible_images_decoded')

      const navigationReady = !navigationCommand || signals.navigation.status === 'ready'
      // Network quiet is observational context only. A page with a long-running
      // fetch/XHR can still be fully observable, so it must not block the fallback.
      const fallbackReady =
        ['fonts', 'images'].every(key => signals[key].status === 'ready') &&
        ['ready', 'skipped'].includes(signals.dom.status)
      if (navigationReady && fallbackReady) {
        const frameBudget = Math.max(1, deadline - Date.now())
        await Promise.race([
          page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))),
          page.waitForTimeout(frameBudget).then(() => { throw new Error('animation_frame_timeout') }),
        ])
          .then(() => { signals.paint = signal('ready', 'two_animation_frames') })
          .catch(() => { signals.paint = signal('error', 'animation_frame_failed') })
        if (signals.paint.status === 'ready') {
          return {
            wait: {
              status: 'ready',
              reason: navigationCommand
                ? signals.navigation.detail
                : signals.dom.status === 'skipped'
                  ? 'page_observable_dom_active'
                  : (signals.network.status === 'ready' ? 'page_stable' : 'page_stable_network_pending'),
              elapsedMs: Date.now() - startedAt,
              signals,
            },
            page: { url: page.url(), title: await page.title() },
          }
        }
      }
      await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())))
    }

    return {
      wait: { status: 'timed_out', reason: 'readiness_deadline', elapsedMs: Date.now() - startedAt, signals },
      page: { url: page.url(), title: await page.title().catch(() => '') },
    }
  }`
}
