# cmdc-worker

A Claude Code mod in which Claude plans and reviews while [Command Code](https://commandcode.ai) (`cmdc`) writes the code.

- **Tool `mcp__cmdc-worker__implement`** (`task`, `cwd?`, `resume?`): runs `cmdc -p <task> --yolo --output-format json` in `cwd` and returns cmdc's summary, `git status`, `git diff --stat` and the full diff for Claude to review. `resume: true` continues cmdc's previous session through `--session <id>`, so fix rounds keep cmdc's context.
- **Pane "cmdc worker"** (`/cmdc`): shows the run live (tool calls, cmdc's messages, turn and elapsed time), with a Stop button (`s`) and a Clear log button (`c`).

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
