# watchdog-diff

pi extension: one read-only tool, `watchdog_diff`, that reports the current agent session's change boundary in git.

## Why

When an agent (or a spawned teammate) works in a repo, the first question in any review or incident is: **what did this session actually change?** Plain `git diff` is not that — it shows working-tree changes, misses commits made during the session, and does not list untracked files. `watchdog_diff` pre-computes that boundary:

- On `session_start`, it captures git HEAD as the session baseline.
- `watchdog_diff` returns the diff from that baseline to the current working tree (staged + unstaged + commits made during the session), the list of commits since the baseline, and untracked paths to inspect with `read`.

Changes committed before the session started are out of scope by design — that is the responsibility boundary.

## Tool

`watchdog_diff`

| Param | Type | Effect |
| --- | --- | --- |
| `path` | string, optional | Limit commits/diff/untracked to one file or directory |
| `stat` | boolean, optional | Diffstat summary instead of the full diff |

Output sections: session base SHA, commits since base (capped at 10), the diff (capped at ~48KB, use `path` to narrow), untracked paths (capped at 200).

Read-only: annotations declare `readOnlyHint` and `idempotentHint`; `bash`/`execFile` runs git with argument arrays only (no shell), and a trailing `--` pathspec separator prevents option injection.

In a repo with no commits yet, the baseline is git's empty tree, so the first session still gets a full boundary report.

## Install

```bash
pi install ./watchdog-diff
```

(from the `ai-agent-plugin` repo root; installs to `~/.pi/agent/settings.json` packages)

Child sessions spawned by pi-teams load user-level extensions too, so agents can call `watchdog_diff` — add it to an agent's `tools:` frontmatter whitelist (e.g. `reviewer`). The tool name intentionally matches the one pi-subagents used, so existing agent definitions keep working.

## Test

```bash
node --test test/git-boundary.test.ts
```

Requires Node >= 23 (native TypeScript type stripping; verified on 24).
