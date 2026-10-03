// Turns cmdc's `--output-format json` NDJSON stream into readable log lines.

export type CmdcLine =
  | { type: 'event'; event: { type: string; [key: string]: unknown } }
  | { type: 'result'; subtype?: string; sessionId?: string; finalText?: string; stopReason?: string }

import type { Tokens } from '../types'

export type Parsed = {
  lines: string[]
  sessionId?: string
  finalText?: string
  stopReason?: string
  turn?: number
  activity?: string
  /** One model request's usage; counted once per request, never from turn or run totals. */
  usage?: Tokens
  model?: string
}

export const NO_TOKENS: Tokens = { input: 0, output: 0, cacheRead: 0, context: 0 }

/** Sums the counts; `context` is the later one's, as each request resends the whole context. */
export const addTokens = (a: Tokens, b: Tokens): Tokens => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  context: b.context || a.context || 0,
})

const count = (n: number) =>
  n < 1000 ? String(n) : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`

/**
 * `↑176k new + 4.2M cached · ctx 120k ↓37k`: input split into uncached and cache reads
 * (summed over requests), then the last request's context size.
 */
export function formatTokens(t: Tokens): string {
  const cached = t.cacheRead > 0 ? ` + ${count(t.cacheRead)} cached` : ''
  const context = t.context ? ` · ctx ${count(t.context)}` : ''
  return `↑${count(Math.max(0, t.input - t.cacheRead))} new${cached}${context} ↓${count(t.output)}`
}

export function formatMs(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

// The argument most worth showing for a tool call: a path, a command, a pattern.
function toolArg(input: unknown): string {
  if (input === null || typeof input !== 'object') return ''
  const fields = input as Record<string, unknown>
  for (const key of ['file_path', 'path', 'command', 'pattern', 'query', 'url']) {
    const value = fields[key]
    if (typeof value === 'string') return clip(oneLine(value), 90)
  }
  return ''
}

/** Splits buffered stdout into complete lines, returning the unfinished tail. */
export function splitLines(buffer: string): { complete: string[]; rest: string } {
  const parts = buffer.split('\n')
  const rest = parts.pop() ?? ''
  return { complete: parts.filter(line => line.trim() !== ''), rest }
}

export function parseLine(raw: string): Parsed {
  let line: CmdcLine
  try {
    line = JSON.parse(raw) as CmdcLine
  } catch {
    return { lines: [clip(oneLine(raw), 160)] }
  }

  if (line.type === 'result') {
    return { lines: [], sessionId: line.sessionId, finalText: line.finalText, stopReason: line.stopReason }
  }

  const ev = line.event
  switch (ev.type) {
    case 'run_start':
      return { lines: ['● run started'], sessionId: ev.sessionId as string | undefined }
    case 'turn_start':
      return { lines: [], turn: ev.turnNumber as number, activity: 'thinking' }
    case 'tool_queued': {
      const arg = toolArg(ev.input)
      const call = `${String(ev.toolName)}${arg ? ` ${arg}` : ''}`
      return { lines: [`▸ ${call}`], activity: call }
    }
    case 'model_request_end': {
      const u = ev.usage as Partial<Record<'inputTokens' | 'outputTokens' | 'cacheReadTokens', number>> | undefined
      const usage = u && { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cacheRead: u.cacheReadTokens ?? 0, context: u.inputTokens ?? 0 }
      return { lines: [], usage, model: typeof ev.model === 'string' ? ev.model : undefined }
    }
    case 'tool_completed': {
      const result = ev.result as { type: string; text?: string }[] | undefined
      const text = result?.find(block => block.type === 'text')?.text ?? ''
      const isError = ev.isError === true || /^error/i.test(text)
      return { lines: isError ? [`  ✗ ${clip(oneLine(text), 140)}`] : [] }
    }
    case 'message_end': {
      const content = ev.content as { type: string; text?: string }[] | undefined
      const text = content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? ''
      return { lines: text.trim() ? text.trim().split('\n').map(row => `  ${clip(row, 160)}`) : [] }
    }
    case 'error':
      return { lines: [`✗ ${clip(oneLine(String(ev.message ?? JSON.stringify(ev))), 160)}`] }
    case 'run_end': {
      const result = ev.result as { finalText?: string; stopReason?: string } | undefined
      return { lines: [], finalText: result?.finalText, stopReason: result?.stopReason }
    }
    default:
      return { lines: [] }
  }
}
