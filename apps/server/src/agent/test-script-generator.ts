import type { AgentReplayLocator, ScreenshotDevicePresetSnapshot } from '@viewport-lab/shared'

export interface RecordedStep {
  stepIndex: number
  command: string
  args: string[]
  purpose: string
  locator: string | null
  replayLocator: AgentReplayLocator | null
}

export function generateSpec(
  device: ScreenshotDevicePresetSnapshot,
  url: string,
  task: string,
  steps: RecordedStep[],
): string {
  const deviceLabel = `${device.platformName} ${device.presetName}`
  const lines: string[] = [
    `import { test } from '@playwright/test'`,
    '',
    `test.use({`,
    `  viewport: { width: ${device.viewport.width}, height: ${device.viewport.height} },`,
    `  screen: { width: ${device.viewport.width}, height: ${device.viewport.height} },`,
    `  deviceScaleFactor: ${device.deviceScaleFactor},`,
    `  isMobile: ${device.isMobile},`,
    `  hasTouch: ${device.hasTouch},`,
    `})`,
    '',
    `test.describe('${escapeQuote(deviceLabel)} · 探索任务', () => {`,
    `  test('${escapeQuote(task.slice(0, 60))}', async ({ page }) => {`,
    `    await page.goto('${escapeQuote(url)}')`,
  ]

  let screenshotIndex = 0
  for (const step of steps) {
    const code = stepToPlaywrightCode(step)
    if (code) {
      lines.push(`    // ${step.purpose}`)
      lines.push(...code.map((c) => `    ${c}`))
    }
    if (step.command !== 'snapshot' && step.command !== 'find') {
      screenshotIndex++
      lines.push(
        `    await page.waitForTimeout(2000)`,
        `    await page.screenshot({ path: 'screenshots/${String(screenshotIndex).padStart(2, '0')}.png', scale: 'device' })`,
      )
    }
  }

  lines.push(`  })`)
  lines.push(`})`)
  lines.push('')
  return lines.join('\n')
}

function stepToPlaywrightCode(step: RecordedStep): string[] {
  const ref = step.args.find((a) => /^[fe]\d/.test(a)) ?? null

  switch (step.command) {
    case 'goto':
      return [`await page.goto('${escapeQuote(step.args[0] ?? '')}')`]

    case 'go-back':
      return ['await page.goBack()']

    case 'go-forward':
      return ['await page.goForward()']

    case 'reload':
      return ['await page.reload()']

    case 'click':
      return [buildLocatorCall(step.locator, ref, 'click()')]

    case 'dblclick':
      return [buildLocatorCall(step.locator, ref, 'dblclick()')]

    case 'fill':
      return [buildLocatorCall(step.locator, ref, `fill('${escapeQuote(step.args[1] ?? '')}')`)]

    case 'press':
      return [`await page.keyboard.press('${escapeQuote(step.args[0] ?? 'Enter')}')`]

    case 'hover':
      return [buildLocatorCall(step.locator, ref, 'hover()')]

    case 'select':
      return [
        buildLocatorCall(step.locator, ref, `selectOption('${escapeQuote(step.args[1] ?? '')}')`),
      ]

    case 'check':
      return [buildLocatorCall(step.locator, ref, 'check()')]

    case 'uncheck':
      return [buildLocatorCall(step.locator, ref, 'uncheck()')]

    case 'snapshot':
      return ['// snapshot: 仅为获取元素 ref，不产生可见操作']

    case 'find':
      return [`// find: 搜索 "${step.args[0] ?? ''}"`]

    case 'eval':
      return [`await page.evaluate(${step.args[0] ?? '() => {}'})`]

    default:
      return [`// TODO: unsupported command "${step.command}"`]
  }
}

function buildLocatorCall(locator: string | null, ref: string | null, method: string): string {
  if (locator) {
    return `await page.${locator}.${method}`
  }
  if (ref) {
    return `// TODO: ref ${ref} (unstable, re-capture with snapshot)\n    // await page.locator('internal:ref=${ref}').${method}`
  }
  return `// TODO: no locator or ref available`
}

function escapeQuote(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}
