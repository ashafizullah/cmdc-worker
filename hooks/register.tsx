import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Job, Run, RunStatus, Tokens } from '../types'
import { NO_TOKENS, addTokens, formatMs, formatTokens, parseLine, splitLines } from './events'

const PANE = 'cmdc-worker'
const TOOL = 'implement'
const LOG_LIMIT = 400
const DIFF_LIMIT = 60_000
const VERIFY_LIMIT = 6_000
const VERIFY_TIMEOUT_MS = 10 * 60_000
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

const IDLE: Run = { status: 'idle', task: '', cwd: '', turns: 0 }
const run = atom({ plugin: 'cmdc-worker', key: 'run' } as const, IDLE)
const log = atom({ plugin: 'cmdc-worker', key: 'log' } as const, [] as string[])
const job = atom({ plugin: 'cmdc-worker', key: 'job' } as const, null as Job | null)
const frame = atom({ plugin: 'cmdc-worker', key: 'frame' } as const, 0)

const DESCRIPTION = `Hand an implementation task to Command Code (cmdc), a separate coding agent, and get back what it changed and whether it passes.

You are the planner and reviewer; cmdc is the implementer. The point is to spend as few of your own requests as possible, so:
1. Do not explore the code first: cmdc reads the codebase itself. Write ONE task per call from what you already know: the goal, the expected behaviour, the constraints (what not to touch, patterns to follow), and any files or functions you already know matter.
2. Call this tool with \`verify\` set to the command that proves the change (tests, typecheck, lint). cmdc runs headless with all permissions (--yolo) in \`cwd\`; the person watches it live in the "cmdc worker" pane. After cmdc finishes the plugin runs \`verify\` itself.
3. Review the report in one go: the diff (only what this run changed, new files in full) and the \`verify\` result. Do not rerun the tests or reread the files unless the report leaves a real doubt. Do not trust cmdc's own summary.
4. If anything is wrong or missing, call again with \`resume: true\` and a precise list of fixes (file, line, what is wrong, what you expect). Once the change is right, report to the person, including the time and token figures from the report.

For a small edit you can make in one or two steps yourself, make it yourself instead: a cmdc round costs you at least two requests. Do not make cmdc's edits yourself unless cmdc fails repeatedly on the same point. One run at a time.`

type Input = { task?: unknown; cwd?: unknown; resume?: unknown; verify?: unknown }

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters cut; read the files directly)` : text

async function git($: EngineInterface, cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(['git', ...args], { cwd, env, timeoutMs: 30_000 })
    return exitCode === 0 ? stdout : `(git ${args[0]} failed: ${stderr.trim()})`
  } catch (error) {
    return `(git ${args[0]} failed: ${String(error)})`
  }
}

/** Runs the verify command and gives its exit code and output, the tail kept when long. */
async function verify($: EngineInterface, cwd: string, command: string): Promise<{ code: number | null; output: string }> {
  try {
    const { exitCode, stdout, stderr } = await $.process.run(['sh', '-c', command], { cwd, timeoutMs: VERIFY_TIMEOUT_MS })
    const output = [stdout, stderr].filter(text => text.trim()).join('\n').trim()
    return { code: exitCode, output: output.length > VERIFY_LIMIT ? `… (${output.length - VERIFY_LIMIT} earlier characters cut)\n${output.slice(-VERIFY_LIMIT)}` : output }
  } catch (error) {
    return { code: null, output: `(could not run: ${String(error)})` }
  }
}

/**
 * The working tree as a git tree object, untracked files included (ignored ones not),
 * written through a private index so the person's staging area is left alone.
 */
async function snapshot($: EngineInterface, cwd: string): Promise<string | undefined> {
  const gitDir = (await git($, cwd, ['rev-parse', '--absolute-git-dir'])).trim()
  if (!gitDir || gitDir.startsWith('(')) return undefined
  const env = { GIT_INDEX_FILE: `${gitDir}/cmdc-worker.index` }
  const head = await git($, cwd, ['read-tree', 'HEAD'], env)
  if (head.startsWith('(')) await git($, cwd, ['read-tree', '--empty'], env)
  if ((await git($, cwd, ['add', '-A'], env)).startsWith('(')) return undefined
  const tree = (await git($, cwd, ['write-tree'], env)).trim()
  return /^[0-9a-f]{40,64}$/.test(tree) ? tree : undefined
}

const elapsed = (from?: number, to?: number) => (from === undefined ? '' : formatMs((to ?? Date.now()) - from))

const tokensOf = (u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): Tokens => {
  const input = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
  return { input, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, context: input }
}

async function sessionUsd($: EngineInterface): Promise<number> {
  try {
    return (await $.session.usage()).cost?.usd ?? 0
  } catch {
    return 0
  }
}

// The running child's stream, so Stop can end it. Lost on reload, as is the child.
let current: AsyncIterator<unknown> | undefined
// Spins the pane's spinner while a run is going.
let ticker: Timer | undefined
type Spent = { turnId: string; ms: number; tokens: Tokens; usd: number; usdShared?: boolean }
// Claude's model steps in each loop's current turn (main, or a subagent's run), so a job
// started mid-turn counts the planning before it. Keyed by the loop's agent id, '' for main.
const loops = new Map<string, Spent>()
// The session cost after the last model step of any loop. The session's ledger is the only
// source of cost and is shared by every loop, so a cost read while another loop was stepping
// may hold that loop's spend too; such a figure is flagged rather than shown.
let lastUsd = 0

const loopOf = (agentId?: string) => agentId ?? ''

const usdOf = (j: Job) => (j.usdShared ? '$? (other agents ran alongside, so the session cost cannot be split)' : `$${j.claudeUsd.toFixed(2)}`)

async function append($: EngineInterface, lines: string[]) {
  if (lines.length === 0) return
  await update($, log, list => [...(list ?? []), ...lines].slice(-LOG_LIMIT))
}

function stopTicker() {
  ticker?.cancel()
  ticker = undefined
}

async function stop($: EngineInterface) {
  if (!current) return
  const stream = current
  current = undefined
  stopTicker()
  await stream.return?.()
  await update($, run, r => ({ ...(r ?? IDLE), status: 'stopped' as RunStatus, endedAt: Date.now() }))
  await append($, ['■ stopped'])
}

/** Starts a job for a new task, or brings back the current one for a fix round in a later turn. */
async function joinJob($: EngineInterface, isFix: boolean, loop: string) {
  const spent = loops.get(loop)
  const since = { claudeMs: spent?.ms ?? 0, claude: spent?.tokens ?? NO_TOKENS, claudeUsd: spent?.usd ?? 0, usdShared: !!spent?.usdShared }
  const existing = await read($, job)
  if (isFix && existing?.active) return
  if (isFix && existing) {
    await update($, job, j =>
      j && {
        ...j,
        active: true,
        loop,
        claudeMs: j.claudeMs + since.claudeMs,
        claude: addTokens(j.claude, since.claude),
        claudeUsd: j.claudeUsd + since.claudeUsd,
        usdShared: j.usdShared || since.usdShared,
      },
    )
    return
  }
  await update($, job, () => ({ startedAt: Date.now(), active: true, loop, cmdcMs: 0, cmdc: NO_TOKENS, runs: [], ...since }))
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
          verify: {
            type: 'string',
            description: 'Shell command run in `cwd` after cmdc finishes (e.g. `npm test`); its exit code and output tail go in the report.',
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

  // Claude's side: each model step's own time (tools, cmdc included, run outside it) and usage,
  // counted for the loop that called cmdc only; other loops step past the job.
  on('turn.step', async function* ($, e, next) {
    const started = Date.now()
    const before = await sessionUsd($)
    const result = yield* next(e)
    const ms = Date.now() - started
    const tokens = result?.usage ? tokensOf(result.usage) : NO_TOKENS
    const usd = await sessionUsd($)
    const cost = Math.max(0, usd - Math.max(before, lastUsd))
    lastUsd = Math.max(lastUsd, usd)
    const loop = loopOf(e.agentId)
    const prior = loops.get(loop)
    const spent = prior?.turnId === e.turnId ? prior : { turnId: e.turnId, ms: 0, tokens: NO_TOKENS, usd: 0 }
    for (const [other, s] of loops) if (other !== loop) s.usdShared = true
    loops.set(loop, { ...spent, ms: spent.ms + ms, tokens: addTokens(spent.tokens, tokens), usd: spent.usd + cost })
    const j = await read($, job)
    if (j?.active && (j.loop ?? '') === loop) {
      await update($, job, j => j && { ...j, claudeMs: j.claudeMs + ms, claude: addTokens(j.claude, tokens), claudeUsd: j.claudeUsd + cost })
    } else if (j?.active && !j.usdShared) {
      await update($, job, j => j && { ...j, usdShared: true })
    }
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const loop = loopOf(e.agentId)
    if (loops.get(loop)?.turnId === e.turnId) loops.delete(loop)
    const j = await read($, job)
    if (j?.active && (j.loop ?? '') === loop) await update($, job, j => j && { ...j, active: false })
    return next(e)
  })

  on('tool.call', { tool: 'mcp__cmdc-worker__implement' }, async ($, e, next) => {
    const input = e as unknown as Input
    const task = typeof input.task === 'string' ? input.task.trim() : ''
    if (!task) return { deny: 'task is required.' }
    const verifyCommand = typeof input.verify === 'string' ? input.verify.trim() : ''
    if (current) return { deny: 'A cmdc run is already in progress; wait for it or stop it in the pane.' }

    const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : await $.session.cwd()
    const previous = await read($, run)
    const resumeId = input.resume === true ? previous.sessionId : undefined
    if (input.resume === true && !resumeId) return { deny: 'No previous cmdc session to resume; call without resume.' }
    await joinJob($, !!resumeId, loopOf(e.agentId))

    const argv = [
      'cmdc', '-p', task,
      '--output-format', 'json',
      '--yolo', '-t', '--skip-onboarding', '--no-auto-update',
      '--max-turns', String(maxTurns),
      ...(model ? ['--model', model] : []),
      ...(resumeId ? ['--session', resumeId] : []),
    ]

    const before = await snapshot($, cwd)
    const startedAt = Date.now()
    await update($, run, () => ({ status: 'running' as RunStatus, task, cwd, sessionId: resumeId, startedAt, turns: 0, activity: 'starting', tokens: NO_TOKENS }))
    await append($, ['', `━━ ${resumeId ? 'fix' : 'task'} · ${new Date(startedAt).toLocaleTimeString()} ━━`, ...task.split('\n').slice(0, 6).map(row => `» ${row}`)])
    void $.ui.open({ id: PANE, title: 'cmdc worker' })
    $.ui.status('cmdc: running')
    stopTicker()
    ticker = $.clock.every(120, () => void update($, frame, f => ((f ?? 0) + 1) % SPINNER.length))

    let sessionId = resumeId
    let finalText: string | undefined
    let stopReason: string | undefined
    let stderr = ''
    let buffer = ''
    let tokens = NO_TOKENS
    let turns = 0
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
        let activity: string | undefined
        let usedModel: string | undefined
        for (const raw of complete) {
          const parsed = parseLine(raw)
          lines.push(...parsed.lines)
          sessionId = parsed.sessionId ?? sessionId
          finalText = parsed.finalText ?? finalText
          stopReason = parsed.stopReason ?? stopReason
          turns = parsed.turn ?? turns
          activity = parsed.activity ?? activity
          usedModel = parsed.model ?? usedModel
          if (parsed.usage) tokens = addTokens(tokens, parsed.usage)
        }
        await update($, run, r => ({
          ...(r ?? IDLE),
          turns,
          sessionId,
          tokens,
          activity: activity ?? r?.activity,
          model: usedModel ?? r?.model,
        }))
        await append($, lines)
      }
    } catch (error) {
      stderr += `\n${String(error)}`
    } finally {
      next.signal?.removeEventListener('abort', onAbort)
    }

    stopTicker()
    const wasStopped = current === undefined
    current = undefined
    const ok = !wasStopped && exit?.code === 0
    const status: RunStatus = wasStopped ? 'stopped' : ok ? 'done' : 'failed'
    const endedAt = Date.now()
    const ms = endedAt - startedAt
    await update($, run, r => ({ ...(r ?? IDLE), status, sessionId, finalText, endedAt, activity: undefined }))
    await update($, job, j =>
      j && {
        ...j,
        cmdcMs: j.cmdcMs + ms,
        cmdc: addTokens(j.cmdc, tokens),
        runs: [...j.runs, { kind: resumeId ? ('fix' as const) : ('task' as const), status, ms, turns, tokens }],
      },
    )
    await append($, [`${ok ? '✓' : '✗'} ${status} in ${formatMs(ms)} · ${formatTokens(tokens)}${exit?.code ? ` (exit ${exit.code})` : ''}`])
    $.ui.status(undefined)
    $.ui.toast(`cmdc ${status}`)

    const check = verifyCommand && !wasStopped ? await verify($, cwd, verifyCommand) : undefined
    if (check) await append($, [`${check.code === 0 ? '✓' : '✗'} verify ${verifyCommand} (exit ${check.code ?? 'none'})`])

    const after = await snapshot($, cwd)
    const range = before && after ? [before, after] : []
    const [statusShort, stat, diff] = await Promise.all([
      git($, cwd, ['status', '--short']),
      git($, cwd, ['diff', '--stat', ...range]),
      git($, cwd, ['diff', ...range]),
    ])
    const scope = range.length ? 'what this run changed, new files in full' : 'tracked changes against the index; read untracked (??) files directly'

    const j = await read($, job)
    const report = [
      `cmdc ${status} after ${formatMs(ms)} (exit ${exit?.code ?? 'none'}${stopReason ? `, ${stopReason}` : ''}). Session ${sessionId ?? 'unknown'}.`,
      `This run: ${turns} turns, ${formatTokens(tokens)} tokens.`,
      ...(j
        ? [`Job so far (${j.runs.length} run${j.runs.length === 1 ? '' : 's'}): cmdc ${formatMs(j.cmdcMs)}, ${formatTokens(j.cmdc)}; Claude ${formatMs(j.claudeMs)}, ${formatTokens(j.claude)}, ${usdOf(j)}.`]
        : []),
      '',
      "## cmdc's own summary (verify, don't trust)",
      finalText?.trim() || '(none)',
      ...(ok ? [] : ['', '## stderr (tail)', stderr.trim() || '(empty)']),
      ...(check
        ? ['', `## verify: ${verifyCommand} (${check.code === 0 ? 'passed' : `failed, exit ${check.code ?? 'none'}`})`, check.output || '(no output)']
        : ['', '## verify', "(none given: run the checks yourself, and pass `verify` next time)"]),
      '',
      '## git status --short',
      statusShort.trim() || '(clean)',
      '',
      `## git diff --stat (${scope})`,
      stat.trim() || '(no changes)',
      '',
      '## git diff',
      clip(diff, DIFF_LIMIT) || '(empty)',
      '',
      'Now review this against your instructions in one step. If anything is off, call again with resume: true and a precise fix list.',
    ].join('\n')

    return { result: report }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, run)
    const lines = await read($, log)
    const j = await read($, job)
    const f = await read($, frame)
    const running = r.status === 'running'
    const runs = j?.runs ?? []
    const room = Math.max(3, (e.viewport?.rows ?? 24) - 9 - Math.min(runs.length, 5))
    const color = running ? 'yellow' : r.status === 'done' ? 'green' : r.status === 'idle' ? undefined : 'red'
    const firstLine = r.task.split('\n')[0] ?? ''
    const liveMs = running && r.startedAt !== undefined ? Date.now() - r.startedAt : 0
    const liveTokens = running ? r.tokens ?? NO_TOKENS : NO_TOKENS

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          {running && <Text color="yellow">{SPINNER[f % SPINNER.length]}</Text>}
          <Text bold color={color}>{r.status}</Text>
          {running && r.activity && <Text wrap="truncate-end">{r.activity}</Text>}
        </Box>
        {r.status !== 'idle' && (
          <Text dimColor wrap="truncate-end">
            run · turn {r.turns} · {elapsed(r.startedAt, running ? undefined : r.endedAt)} · {formatTokens(r.tokens ?? NO_TOKENS)}
            {r.model ? ` · ${r.model}` : ''}
          </Text>
        )}
        {j && (
          <Box flexDirection="row" gap={2}>
            <Text wrap="truncate-end">
              <Text color="cyan">cmdc</Text> {formatMs(j.cmdcMs + liveMs)} · {formatTokens(addTokens(j.cmdc, liveTokens))}
            </Text>
            <Text wrap="truncate-end">
              <Text color="magenta">Claude</Text> {formatMs(j.claudeMs)} · {formatTokens(j.claude)} · {j.usdShared ? '$?' : `$${j.claudeUsd.toFixed(2)}`}
            </Text>
            <Text dimColor>total {formatMs(j.cmdcMs + liveMs + j.claudeMs)}</Text>
          </Box>
        )}
        {runs.slice(-5).map((s, i) => (
          <Text dimColor wrap="truncate-end">
            {runs.length - Math.min(runs.length, 5) + i + 1}. {s.kind} {s.status === 'done' ? '✓' : '✗'} {formatMs(s.ms)} · {s.turns} turns · {formatTokens(s.tokens)}
          </Text>
        ))}
        {firstLine && <Text dimColor wrap="truncate-end">» {firstLine}</Text>}
        <Box flexDirection="column" marginTop={1}>
          {lines.length === 0 && <Text dimColor>No runs yet. Claude hands tasks to cmdc here.</Text>}
          {lines.slice(-room).map(line => (
            <Text dimColor={line.startsWith('  ')} color={line.startsWith('✗') || line.startsWith('  ✗') ? 'red' : undefined} wrap="truncate-end">
              {line || ' '}
            </Text>
          ))}
        </Box>
        <Box flexDirection="row" gap={1} marginTop={1}>
          {running && <Button key="stop" hotkey="s" variant="primary" onPress={() => stop($)}>Stop</Button>}
          <Button key="clear" hotkey="c" onPress={() => update($, log, () => [])}>Clear log</Button>
        </Box>
      </Box>
    )
  })
}
