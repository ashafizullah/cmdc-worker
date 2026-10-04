import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { formatMs, formatTokens, parseLine, splitLines } from '../hooks/events'

const TOOL = 'mcp__cmdc-worker__implement'

const ndjson = (...events: object[]) => events.map(event => JSON.stringify(event)).join('\n') + '\n'

const RUN = ndjson(
  { type: 'event', event: { type: 'run_start', sessionId: 'sess-1' } },
  { type: 'event', event: { type: 'turn_start', turnNumber: 1 } },
  { type: 'event', event: { type: 'tool_queued', toolName: 'write_file', input: { file_path: 'src/a.ts' } } },
  { type: 'event', event: { type: 'model_request_end', model: 'm1', usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 800 } } },
  { type: 'event', event: { type: 'turn_end', turnNumber: 1, usage: { inputTokens: 1000, outputTokens: 20, cacheReadTokens: 800 } } },
  { type: 'event', event: { type: 'message_end', content: [{ type: 'text', text: 'Added a.ts' }] } },
  { type: 'result', subtype: 'success', sessionId: 'sess-1', stopReason: 'end_turn', finalText: 'Added a.ts' },
)

function world(on: On) {
  const spawned: (readonly string[])[] = []
  const gitCalls: (readonly string[])[] = []
  let tree = 0
  mock.store(on)
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isOpen: true } }) as never)
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', (_, e) => {
    gitCalls.push(e.argv)
    const sub = e.argv[1]
    const stdout =
      e.argv[0] === 'sh' ? '# pass 3\n'
      : sub === 'status' ? '?? src/a.ts\n'
      : sub === 'rev-parse' ? '/repo/.git\n'
      : sub === 'write-tree' ? `${String(++tree).padStart(40, '0')}\n`
      : sub === 'diff' && e.argv.length > 3 ? 'diff --git a/src/a.ts b/src/a.ts\n+new file\n'
      : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('process.spawn', async function* (_, e) {
    spawned.push(e.argv)
    // Split mid-line to exercise buffering.
    yield { stream: 'stdout' as const, text: RUN.slice(0, 50) }
    yield { stream: 'stdout' as const, text: RUN.slice(50) }
    return { value: { code: 0, signal: null } }
  })
  return { spawned, gitCalls }
}

test('parses cmdc events into log lines', async () => {
  expect(parseLine(JSON.stringify({ type: 'event', event: { type: 'tool_queued', toolName: 'bash', input: { command: 'pnpm test' } } })).lines)
    .toEqual(['▸ bash pnpm test'])
  const end = parseLine(JSON.stringify({ type: 'event', event: { type: 'model_request_end', model: 'm', usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3 } } }))
  expect(end.usage).toEqual({ input: 5, output: 2, cacheRead: 3, context: 5 })
  expect(parseLine(JSON.stringify({ type: 'event', event: { type: 'turn_end', usage: { inputTokens: 5 } } })).usage).toBeUndefined()
  expect(formatTokens({ input: 4_400_000, output: 36_874, cacheRead: 4_224_000, context: 120_000 })).toBe('↑176k new + 4.2M cached · ctx 120k ↓37k')
  expect(formatTokens({ input: 900, output: 5, cacheRead: 0 })).toBe('↑900 new ↓5')
  expect(formatMs(802_000)).toBe('13m22s')
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
  const { spawned, gitCalls } = world(on)

  const first = await $.tool.call({ tool: TOOL, task: 'Add a.ts' } as never)
  const report = String(first.result)
  expect(report).toContain('cmdc done')
  expect(report).toContain('Session sess-1')
  expect(report).toContain('Added a.ts')
  expect(report).toContain('?? src/a.ts')
  expect(spawned[0]).toContain('--yolo')
  expect(spawned[0]).not.toContain('--session')
  expect(report).toContain('This run: 1 turns, ↑200 new + 800 cached · ctx 1.0k ↓20 tokens.')
  expect(report).toContain('Job so far (1 run): cmdc')
  expect(report).toContain('+new file')
  expect(report).toContain('(none given: run the checks yourself')
  // The diff spans the trees written before and after the run.
  expect(gitCalls.find(a => a[1] === 'diff' && a[2] !== '--stat')?.slice(2)).toEqual(['0'.repeat(39) + '1', '0'.repeat(39) + '2'])

  const second = String((await $.tool.call({ tool: TOOL, task: 'Rename a.ts to b.ts', resume: true } as never)).result)
  expect(spawned[1]?.slice(-2)).toEqual(['--session', 'sess-1'])
  expect(second).toContain('Job so far (2 runs)')
  expect(second).toContain('↑400 new + 1.6k cached · ctx 1.0k ↓40')
})

test('the pane shows the job: cmdc and Claude figures and each run', async ($, on) => {
  world(on)
  await $.tool.call({ tool: TOOL, task: 'Add a.ts' } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'cmdc-worker', surface, component: 'Pane', requestId: 'cmdc-worker', props: { title: 'cmdc worker', isFocused: false, bodyColumns: 120 } } as never)
    expect(await ui.find({ type: 'Text', text: /cmdc.*↑200 new \+ 800 cached · ctx 1\.0k ↓20/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude.*\$0\.00/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\. task ✓ .* 1 turns/ })).toBeDefined()
    await ui.unmount()
  }
})

function claudeSteps($: Parameters<Parameters<typeof test>[1]>[0], on: On) {
  let usd = 0
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], cost: { usd } } }) as never)
  on('turn.step', async function* (_, e) {
    const input = e.agentId ? 10_000 : 100
    usd += e.agentId ? 1 : 0.01
    const usage = { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'm' }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage } as never
  })
  return async (turnId: string, agentId?: string) => {
    const stream = $.turn.step({ turnId, index: 0, model: 'm', messageCount: 1, ...(agentId ? { agentId } : {}) })
    for await (const _ of stream);
    return stream.result
  }
}

const claudeLine = async ($: Parameters<Parameters<typeof test>[1]>[0], text: RegExp) => {
  const ui = await $.ui.mount({ plugin: 'cmdc-worker', surface: 'terminal', component: 'Pane', requestId: 'cmdc-worker', props: { title: 'cmdc worker', isFocused: false, bodyColumns: 120 } } as never)
  const found = await ui.find({ type: 'Text', text })
  await ui.unmount()
  return found
}

test("Claude's figures count the planning before the call and the review after it", async ($, on) => {
  world(on)
  const step = claudeSteps($, on)
  await step('t1')
  await $.tool.call({ tool: TOOL, task: 'Add a.ts' } as never)
  await step('t1')
  expect(await claudeLine($, /Claude.*↑200 new · ctx 100 ↓2 · \$0\.02/)).toBeDefined()
})

test("Claude's figures count only the loop that called cmdc, and flag a shared cost", async ($, on) => {
  world(on)
  const step = claudeSteps($, on)
  await step('t1')
  await step('s1', 'sub-1')
  await $.tool.call({ tool: TOOL, task: 'Add a.ts' } as never)
  await step('s1', 'sub-1')
  await step('t1')
  expect(await claudeLine($, /Claude.*↑200 new · ctx 100 ↓2 · \$\?/)).toBeDefined()
})

test('runs the verify command after cmdc and reports its result', async ($, on) => {
  const { gitCalls } = world(on)
  const report = String((await $.tool.call({ tool: TOOL, task: 'Add a.ts', verify: 'npm test' } as never)).result)
  expect(gitCalls).toContainEqual(['sh', '-c', 'npm test'])
  expect(report).toContain('## verify: npm test (passed)\n# pass 3')
})
