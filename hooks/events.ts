// Turns cmdc's `--output-format json` NDJSON stream into readable log lines.

export type CmdcLine =
  | { type: 'event'; event: { type: string; [key: string]: unknown } }
  | { type: 'result'; subtype?: string; sessionId?: string; finalText?: string; stopReason?: string }

export type Parsed = {
  lines: string[]
  sessionId?: string
  finalText?: string
  stopReason?: string
  turn?: number
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
      return { lines: [], turn: ev.turnNumber as number }
    case 'tool_queued': {
      const arg = toolArg(ev.input)
      return { lines: [`▸ ${String(ev.toolName)}${arg ? ` ${arg}` : ''}`] }
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
