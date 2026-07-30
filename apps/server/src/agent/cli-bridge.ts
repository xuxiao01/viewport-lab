import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
const DEFAULT_BINARY = resolve(rootDir, 'apps/server/node_modules/.bin/playwright-cli')
const DEFAULT_CWD = resolve(rootDir, 'apps/server')

export interface CliResult {
  ok: boolean
  output: string
  error: string | null
}

export interface AgentViewportOptions {
  width: number
  height: number
  deviceScaleFactor: number
  isMobile: boolean
  hasTouch: boolean
}

export interface AgentCliBridge {
  open(session: string, options: AgentViewportOptions): Promise<CliResult>
  snapshot(session: string, filename?: string): Promise<CliResult>
  screenshot(session: string, filename: string): Promise<CliResult>
  generateLocator(session: string, ref: string): Promise<CliResult>
  runCode(session: string, code: string): Promise<CliResult>
  execute(session: string, command: string, args: string[]): Promise<CliResult>
  close(session: string): Promise<CliResult>
}

export function createCliBridge(
  binaryPath: string = DEFAULT_BINARY,
  cwd: string = DEFAULT_CWD,
): AgentCliBridge {
  return new ConcreteCliBridge(binaryPath, cwd)
}

const DEFAULT_TIMEOUT = 30_000
const OPEN_TIMEOUT = 60_000

const ALLOWED_COMMANDS = new Set([
  'goto',
  'go-back',
  'go-forward',
  'reload',
  'click',
  'dblclick',
  'fill',
  'press',
  'hover',
  'select',
  'check',
  'uncheck',
  'snapshot',
  'find',
  'eval',
])

class ConcreteCliBridge implements AgentCliBridge {
  constructor(
    private readonly binary: string,
    private readonly cwd: string,
  ) {}

  async open(session: string, options: AgentViewportOptions): Promise<CliResult> {
    const configDir = await mkdtemp(join(tmpdir(), 'viewport-lab-agent-cli-'))
    const configPath = join(configDir, 'cli.config.json')
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          browser: {
            browserName: 'chromium',
            isolated: true,
            contextOptions: {
              viewport: { width: options.width, height: options.height },
              screen: { width: options.width, height: options.height },
              deviceScaleFactor: options.deviceScaleFactor,
              isMobile: options.isMobile,
              hasTouch: options.hasTouch,
            },
          },
        }),
        'utf8',
      )
      const result = await this.exec(session, 'open', [`--config=${configPath}`], OPEN_TIMEOUT)
      return result
    } finally {
      await rm(configDir, { recursive: true, force: true })
    }
  }

  async snapshot(session: string, filename?: string): Promise<CliResult> {
    const args = filename ? [`--filename=${filename}`] : []
    return this.exec(session, 'snapshot', args)
  }

  async screenshot(session: string, filename: string): Promise<CliResult> {
    return this.exec(session, 'screenshot', [`--filename=${filename}`, '--hires'])
  }

  async generateLocator(session: string, ref: string): Promise<CliResult> {
    return this.exec(session, 'generate-locator', [ref])
  }

  async runCode(session: string, code: string): Promise<CliResult> {
    return this.exec(session, 'run-code', [code])
  }

  async execute(session: string, command: string, args: string[]): Promise<CliResult> {
    if (!ALLOWED_COMMANDS.has(command)) {
      return { ok: false, output: '', error: `不允许的 CLI 命令: ${command}` }
    }
    return this.exec(session, command, args)
  }

  async close(session: string): Promise<CliResult> {
    return this.exec(session, 'close', [])
  }

  private exec(
    session: string,
    command: string,
    args: string[],
    timeout = DEFAULT_TIMEOUT,
  ): Promise<CliResult> {
    const fullArgs =
      session === '__no_session__'
        ? ['--json', command, ...args]
        : [`-s=${session}`, '--json', command, ...args]
    return this.execRawArgs(fullArgs, timeout)
  }

  private execRawArgs(fullArgs: string[], timeout: number): Promise<CliResult> {
    return new Promise((resolvePromise) => {
      execFile(
        this.binary,
        fullArgs,
        { cwd: this.cwd, timeout, maxBuffer: 20 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const output = (stdout || '').trim()
          const errText = (stderr || '').trim()
          if (error) {
            resolvePromise({
              ok: false,
              output: '',
              error: `${error.message}${errText ? `\n${errText}` : ''}`,
            })
            return
          }
          let parsed: Record<string, unknown> | null = null
          try {
            parsed = JSON.parse(output)
          } catch {
            parsed = null
          }
          if (parsed && typeof parsed === 'object') {
            const isError = parsed.isError === true
            const errorVal = parsed.error
            const resultVal = parsed.result
            const snapshotVal = parsed.snapshot
            let outputText = ''
            if (typeof resultVal === 'string') {
              outputText = resultVal
            } else if (typeof snapshotVal === 'object' && snapshotVal !== null) {
              const file = (snapshotVal as Record<string, unknown>).file
              if (typeof file === 'string') {
                outputText = `(snapshot saved to ${file})`
              }
            } else if (typeof snapshotVal === 'string') {
              outputText = snapshotVal
            } else {
              outputText = JSON.stringify(parsed)
            }
            if (isError) {
              resolvePromise({
                ok: false,
                output: outputText.slice(0, 8000),
                error: typeof errorVal === 'string' ? errorVal : outputText.slice(0, 2000),
              })
              return
            }
            resolvePromise({
              ok: true,
              output: outputText,
              error: null,
            })
            return
          }
          resolvePromise({ ok: true, output: output.slice(0, 8000), error: null })
        },
      )
    })
  }
}

export function sanitizeSessionId(raw: string): string {
  return raw
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
}
