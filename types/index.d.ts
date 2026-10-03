export type RunStatus = 'idle' | 'running' | 'done' | 'failed' | 'stopped'

export type Run = {
  status: RunStatus
  task: string
  cwd: string
  sessionId?: string
  startedAt?: number
  endedAt?: number
  turns: number
  finalText?: string
}

declare module 'claude-code' {
  interface PluginState {
    'cmdc-worker': { run: Run; log: string[] }
  }
}
