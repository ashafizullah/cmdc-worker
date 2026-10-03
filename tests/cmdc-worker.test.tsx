import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseLine, splitLines } from '../hooks/events'

const TOOL = 'mcp__cmdc-worker__implement'

const ndjson = (...events: object[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n'

const RUN = ndjson(
  { type: 'event', event: { type: 'run_start', sessionId: 'sess-1' } },
  { type: 'event', event: { type: 'turn_start', turnNumber: 1 } },
  { type: 'event', event: { type: 'tool_queued', toolName: 'write_file', input: { file_path: 'src/a.ts' } } },
  { type: 'event', event: { type: 'message_end', content: [{ type: 'text', text: 'Added a.ts' }] } },
  { type: 'result', subtype: 'success', sessionId: 'sess-1', stopReason: 'end_turn', finalText: 'Added a.ts' },
)

function world(on: On) {
  const spawned: (readonly string[])[] = []
  mock.store(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isOpen: true } }) as never)
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    const sub = e.argv[1]
    const stdout = sub === 'status' ? '?? src/a.ts\n' : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_, e) {
    spawned.push(e.argv)
    // Split mid-line to exercise buffering.
    yield { stream: 'stdout' as const, text: RUN.slice(0, 50) }
    yield { stream: 'stdout' as const, text: RUN.slice(50) }
    return { value: { code: 0, signal: null } }
  })
  return { spawned }
}

test('parses cmdc events into log lines', async () => {
  expect(parseLine(JSON.stringify({ type: 'event', event: { type: 'tool_queued', toolName: 'bash', input: { command: 'pnpm test' } } })).lines)
    .toEqual(['▸ bash pnpm test'])
  expect(parseLine(JSON.stringify({ type: 'event', event: { type: 'run_start', sessionId: 'x' } })).sessionId).toBe('x')
  expect(splitLines('a\nb\npar')).toEqual({ complete: ['a', 'b'], rest: 'par' })
})

test('refuses an empty task', async ($, on) => {
  world(on)
  const result = await $.tool.call({ tool: TOOL, task: '  ' } as never)
  expect(result.deny).toBe('task is required.')
})

test('refuses resume with no previous session', async ($, on) => {
  world(on)
  const result = await $.tool.call({ tool: TOOL, task: 'fix it', resume: true } as never)
  expect(result.deny).toContain('No previous cmdc session')
})

test('runs cmdc, then resumes its session for fixes', async ($, on) => {
  const { spawned } = world(on)

  const first = await $.tool.call({ tool: TOOL, task: 'Add a.ts' } as never)
  const report = String(first.result)
  expect(report).toContain('cmdc done')
  expect(report).toContain('Session sess-1')
  expect(report).toContain('Added a.ts')
  expect(report).toContain('?? src/a.ts')
  expect(spawned[0]).toContain('--yolo')
  expect(spawned[0]).not.toContain('--session')

  await $.tool.call({ tool: TOOL, task: 'Rename a.ts to b.ts', resume: true } as never)
  expect(spawned[1]?.slice(-2)).toEqual(['--session', 'sess-1'])
})
