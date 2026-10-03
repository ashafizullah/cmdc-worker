import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Run, RunStatus } from '../types'
import { parseLine, splitLines } from './events'

const PANE = 'cmdc-worker'
const TOOL = 'implement'
const LOG_LIMIT = 400
const DIFF_LIMIT = 60_000

const IDLE: Run = { status: 'idle', task: '', cwd: '', turns: 0 }
const run = atom({ plugin: 'cmdc-worker', key: 'run' } as const, IDLE)
const log = atom({ plugin: 'cmdc-worker', key: 'log' } as const, [] as string[])

const DESCRIPTION = `Hand an implementation task to Command Code (cmdc), a separate coding agent, and get back what it changed.

You are the planner and reviewer; cmdc is the implementer. Workflow:
1. Plan first: read the code you need, then write ONE self-contained task per call: the goal, the exact files and functions to touch, the constraints (naming, patterns to follow, what not to touch), and how to verify (typecheck/test commands to run).
2. Call this tool. cmdc runs headless with all permissions (--yolo) in \`cwd\`, edits files and may run commands. The person watches it live in the "cmdc worker" pane.
3. Review the returned git status and diff against your instructions yourself: read the changed files, run the typecheck/tests. Do not trust cmdc's own summary.
4. If anything is wrong or missing, call again with \`resume: true\` and a precise list of fixes (file, line, what is wrong, what you expect). Repeat until the change is right, then report to the person.

Do not make the edits yourself unless cmdc fails repeatedly on the same point. One run at a time.`

type Input = { task?: unknown; cwd?: unknown; resume?: unknown }

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters cut; read the files directly)` : text

async function git($: EngineInterface, cwd: string, args: string[]): Promise<string> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(['git', ...args], { cwd, timeoutMs: 30_000 })
    return exitCode === 0 ? stdout : `(git ${args[0]} failed: ${stderr.trim()})`
  } catch (error) {
    return `(git ${args[0]} failed: ${String(error)})`
  }
}

const elapsed = (from?: number, to?: number) => {
  if (from === undefined) return ''
  const seconds = Math.round(((to ?? Date.now()) - from) / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`
}

// The running child's stream, so Stop can end it. Lost on reload, as is the child.
let current: AsyncIterator<unknown> | undefined

async function append($: EngineInterface, lines: string[]) {
  if (lines.length === 0) return
  await update($, log, list => [...(list ?? []), ...lines].slice(-LOG_LIMIT))
}

async function stop($: EngineInterface) {
  if (!current) return
  const stream = current
  current = undefined
  await stream.return?.()
  await update($, run, r => ({ ...(r ?? IDLE), status: 'stopped' as RunStatus, endedAt: Date.now() }))
  await append($, ['■ stopped'])
}

export const register: Register = (on, options) => {
  const model = typeof options.model === 'string' ? options.model.trim() : ''
  const maxTurns = typeof options.maxTurns === 'number' && options.maxTurns > 0 ? options.maxTurns : 60

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'cmdc', description: 'Open the cmdc worker pane' })
    await $.tool.register({
      name: TOOL,
      description: DESCRIPTION,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The full, self-contained instructions for cmdc.' },
          cwd: { type: 'string', description: 'Directory cmdc works in; default the session directory.' },
          resume: {
            type: 'boolean',
            description: "Continue cmdc's previous session (it keeps its context) — use for review fixes.",
          },
        },
        required: ['task'],
      },
    })
    return next(e)
  })

  on('command.run', { command: 'cmdc' }, async $ => {
    await $.ui.open({ id: PANE, title: 'cmdc worker' })
    return { text: 'cmdc worker pane opened.' }
  })

  on('tool.call', { tool: 'mcp__cmdc-worker__implement' }, async ($, e, next) => {
    const input = e as unknown as Input
    const task = typeof input.task === 'string' ? input.task.trim() : ''
    if (!task) return { deny: 'task is required.' }
    if (current) return { deny: 'A cmdc run is already in progress; wait for it or stop it in the pane.' }

    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : await $.session.cwd()
    const previous = await read($, run)
    const resumeId = input.resume === true ? previous.sessionId : undefined
    if (input.resume === true && !resumeId) return { deny: 'No previous cmdc session to resume; call without resume.' }

    const argv = [
      'cmdc', '-p', task,
      '--output-format', 'json',
      '--yolo', '-t', '--skip-onboarding', '--no-auto-update',
      '--max-turns', String(maxTurns),
      ...(model ? ['--model', model] : []),
      ...(resumeId ? ['--session', resumeId] : []),
    ]

    const startedAt = Date.now()
    await update($, run, () => ({ status: 'running' as RunStatus, task, cwd, sessionId: resumeId, startedAt, turns: 0 }))
    await append($, ['', `━━ ${resumeId ? 'fix' : 'task'} · ${new Date(startedAt).toLocaleTimeString()} ━━`, ...task.split('\n').slice(0, 6).map(row => `» ${row}`)])
    void $.ui.open({ id: PANE, title: 'cmdc worker' })
    $.ui.status('cmdc: running')

    let sessionId = resumeId
    let finalText: string | undefined
    let stopReason: string | undefined
    let stderr = ''
    let buffer = ''
    let exit: { code: number | null; signal: string | null } | undefined

    const iterator = $.process.spawn({ argv, cwd })[Symbol.asyncIterator]()
    current = iterator
    const onAbort = () => void stop($)
    next.signal?.addEventListener('abort', onAbort)

    try {
      while (true) {
        const step = await iterator.next()
        if (step.done) {
          exit = step.value as typeof exit
          break
        }
        const chunk = step.value
        if (chunk.stream === 'stderr') {
          stderr = (stderr + chunk.text).slice(-4000)
          continue
        }
        const { complete, rest } = splitLines(buffer + chunk.text)
        buffer = rest
        const lines: string[] = []
        for (const raw of complete) {
          const parsed = parseLine(raw)
          lines.push(...parsed.lines)
          sessionId = parsed.sessionId ?? sessionId
          finalText = parsed.finalText ?? finalText
          stopReason = parsed.stopReason ?? stopReason
          if (parsed.turn !== undefined) {
            const turn = parsed.turn
            await update($, run, r => ({ ...(r ?? IDLE), turns: turn, sessionId }))
          }
        }
        await append($, lines)
      }
    } catch (error) {
      stderr += `\n${String(error)}`
    } finally {
      next.signal?.removeEventListener('abort', onAbort)
    }

    const wasStopped = current === undefined
    current = undefined
    const ok = !wasStopped && exit?.code === 0
    const status: RunStatus = wasStopped ? 'stopped' : ok ? 'done' : 'failed'
    await update($, run, r => ({ ...(r ?? IDLE), status, sessionId, finalText, endedAt: Date.now() }))
    await append($, [`${ok ? '✓' : '✗'} ${status} in ${elapsed(startedAt)}${exit?.code ? ` (exit ${exit.code})` : ''}`])
    $.ui.status(undefined)
    $.ui.toast(`cmdc ${status}`)

    const [statusShort, stat, diff] = await Promise.all([
      git($, cwd, ['status', '--short']),
      git($, cwd, ['diff', '--stat']),
      git($, cwd, ['diff']),
    ])

    const report = [
      `cmdc ${status} after ${elapsed(startedAt)} (exit ${exit?.code ?? 'none'}${stopReason ? `, ${stopReason}` : ''}). Session ${sessionId ?? 'unknown'}.`,
      '',
      "## cmdc's own summary (verify, don't trust)",
      finalText?.trim() || '(none)',
      ...(ok ? [] : ['', '## stderr (tail)', stderr.trim() || '(empty)']),
      '',
      '## git status --short (untracked files show as ??; read them directly)',
      statusShort.trim() || '(clean)',
      '',
      '## git diff --stat',
      stat.trim() || '(no tracked changes)',
      '',
      '## git diff',
      clip(diff, DIFF_LIMIT) || '(empty)',
      '',
      'Now review this against your instructions. If anything is off, call again with resume: true and a precise fix list.',
    ].join('\n')

    return { result: report }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, run)
    const lines = await read($, log)
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 6)
    const color = r.status === 'running' ? 'yellow' : r.status === 'done' ? 'green' : r.status === 'idle' ? undefined : 'red'
    const firstLine = r.task.split('\n')[0] ?? ''

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text bold color={color}>{r.status}</Text>
          {r.status !== 'idle' && <Text dimColor>turn {r.turns} · {elapsed(r.startedAt, r.status === 'running' ? undefined : r.endedAt)}</Text>}
        </Box>
        {firstLine && <Text dimColor wrap="truncate-end">{firstLine}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {lines.length === 0 && <Text dimColor>No runs yet. Claude hands tasks to cmdc here.</Text>}
          {lines.slice(-room).map(line => (
            <Text dimColor={line.startsWith('  ')} color={line.startsWith('✗') || line.startsWith('  ✗') ? 'red' : undefined} wrap="truncate-end">
              {line || ' '}
            </Text>
          ))}
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1}>
          {r.status === 'running' && <Button key="stop" hotkey="s" variant="primary" onPress={() => stop($)}>Stop</Button>}
          <Button key="clear" hotkey="c" onPress={() => update($, log, () => [])}>Clear log</Button>
        </Box>
      </Box>
    )
  })
}
