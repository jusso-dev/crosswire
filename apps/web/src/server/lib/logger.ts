import { redactValue } from './redact'

type Level = 'debug' | 'info' | 'warn' | 'error'
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  child(fields: Record<string, unknown>): Logger
}

export interface LoggerOptions {
  level?: Level
  json?: boolean
  write?: (line: string) => void
  base?: Record<string, unknown>
}

/** Structured logger: JSON lines in production, readable lines in dev. Always redacts. */
export function createLogger(opts: LoggerOptions = {}): Logger {
  const level = opts.level ?? ((process.env.LOG_LEVEL as Level | undefined) ?? 'info')
  const json = opts.json ?? process.env.NODE_ENV === 'production'
  const write = opts.write ?? ((line: string) => process.stdout.write(`${line}\n`))
  const base = opts.base ?? {}

  const log = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return
    const safe = redactValue({ ...base, ...fields }) as Record<string, unknown>
    if (json) {
      write(JSON.stringify({ time: new Date().toISOString(), level: lvl, msg: redactValue(msg), ...safe }))
    } else {
      const extra = Object.keys(safe).length ? ` ${JSON.stringify(safe)}` : ''
      write(`${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} ${String(redactValue(msg))}${extra}`)
    }
  }

  return {
    debug: (m, f) => log('debug', m, f),
    info: (m, f) => log('info', m, f),
    warn: (m, f) => log('warn', m, f),
    error: (m, f) => log('error', m, f),
    child: (fields) => createLogger({ level, json, write, base: { ...base, ...fields } }),
  }
}

export const logger = createLogger()
