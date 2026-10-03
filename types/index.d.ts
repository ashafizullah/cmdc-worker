export type RunStatus = 'idle' | 'running' | 'done' | 'failed' | 'stopped'

/** Token counts; `input` includes the cached part, `cacheRead`. */
export type Tokens = { input: number; output: number; cacheRead: number }

export type Run = {
  status: RunStatus
  task: string
  cwd: string
  sessionId?: string
  startedAt?: number
  endedAt?: number
  turns: number
  finalText?: string
  /** What cmdc is doing now: "thinking", or the tool call it queued last. */
  activity?: string
  model?: string
  tokens?: Tokens
}

/** One cmdc run of a job. */
export type RunSummary = {
  kind: 'task' | 'fix'
  status: RunStatus
  ms: number
  turns: number
  tokens: Tokens
}

/**
 * A task and its fix rounds: cmdc's runs and Claude's planning and reviews. Claude's
 * side counts its model steps in the turns that handed work to cmdc.
 */
export type Job = {
  startedAt: number
  /** Whether Claude's steps count toward this job right now. */
  active: boolean
  cmdcMs: number
  cmdc: Tokens
  claudeMs: number
  claude: Tokens
  claudeUsd: number
  runs: RunSummary[]
}

declare module 'claude-code' {
  interface PluginState {
    'cmdc-worker': { run: Run; log: string[]; job: Job | null; frame: number }
  }
}
