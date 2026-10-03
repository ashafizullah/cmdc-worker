# cmdc-worker

[![CI](https://github.com/ashafizullah/cmdc-worker/actions/workflows/ci.yml/badge.svg)](https://github.com/ashafizullah/cmdc-worker/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Claude Code mod in which Claude plans and reviews while [Command Code](https://commandcode.ai) (`cmdc`) writes the code.

- **Tool `mcp__cmdc-worker__implement`** (`task`, `cwd?`, `resume?`): runs `cmdc -p <task> --yolo --output-format json` in `cwd` and returns cmdc's summary, time and token figures, `git status`, and the diff of what this run changed (new files in full, taken from snapshots of the working tree through a private index) for Claude to review. `resume: true` continues cmdc's previous session through `--session <id>`, so fix rounds keep cmdc's context.
- **Pane "cmdc worker"** (`/cmdc`): shows the run live with a spinner and what cmdc is doing, the run's turn, time, tokens and model, the job's totals for cmdc and for Claude (its model steps' time, tokens and cost in the turns that handed work to cmdc), and one line per run. Stop button (`s`), Clear log button (`c`).

## Loop

1. Claude reads the code and writes one self-contained task.
2. cmdc implements it.
3. Claude reviews the diff, runs typecheck and tests.
4. If something is wrong, Claude calls again with `resume: true` and a precise list of fixes. This repeats until the change is right.

## Settings

`model` (passed as `--model`) and `maxTurns` (default 60), in `/config` or under `pluginConfigs["cmdc-worker"]`.

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
