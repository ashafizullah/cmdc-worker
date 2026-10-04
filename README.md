# cmdc-worker

[![CI](https://github.com/ashafizullah/cmdc-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/ashafizullah/cmdc-worker/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Claude Code mod in which Claude plans and reviews while [Command Code](https://commandcode.ai) (`cmdc`) writes the code.

- **Tool `mcp__cmdc-worker__implement`** (`task`, `cwd?`, `resume?`, `verify?`): runs `cmdc -p <task> --yolo --output-format json` in `cwd`, then the `verify` command (e.g. `npm test`) if given, and returns cmdc's summary, time and token figures, the `verify` exit code and output tail, `git status`, and the diff of what this run changed (new files in full, taken from snapshots of the working tree through a private index) for Claude to review. `resume: true` continues cmdc's previous session through `--session <id>`, so fix rounds keep cmdc's context.
- **Pane "cmdc worker"** (`/cmdc`): shows the run live with a spinner and what cmdc is doing, the run's turn, time, tokens and model, the job's totals for cmdc and for Claude (its model steps' time, tokens and cost in the turns that handed work to cmdc, in the loop that called it; the cost shows as `$?` when other agents ran alongside), and one line per run. Stop button (`s`), Clear log button (`c`).

## Loop

The loop is built to spend as few Claude requests as possible: Claude reads no code up front and runs no checks itself.

1. Claude writes one task from what it already knows, with a `verify` command.
2. cmdc explores the code and implements it; the plugin then runs `verify`.
3. Claude reviews the diff and the `verify` result in one step.
4. If something is wrong, Claude calls again with `resume: true` and a precise list of fixes. This repeats until the change is right.

## Settings

`model` (passed as `--model`) and `maxTurns` (default 60), in `/config` or under `pluginConfigs["cmdc-worker"]`.

## Requirements

- [Claude Code](https://claude.com/claude-code) with a Claude subscription (or API access).
- [Command Code](https://commandcode.ai) with a subscription, and `cmdc` installed and signed in.

## Load

```sh
claude --plugin-dir ~/Projects/cmdc-worker
```

Or add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` to load it in every session.

## Develop

```sh
claude plugin validate .
claude plugin test .
```

> cmdc runs with `--yolo`: it can edit any file and run any command in `cwd` without asking.

## License

[MIT](LICENSE)
