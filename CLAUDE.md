# stellar-x402

## Session Gate

**Before any work, verify:**

| Check | File | If Missing |
|-------|------|------------|
| **Who** | `lore/0-session/current-user.md` | Auto-generated from `LORE_SESSION_CURRENT_USER` env |
| **What** | `lore/0-session/current-task.md` | Pick from `lore/0-session/next-tasks.md`, use MCP tool `lore_set-task` |

## Task-Gated Development

**Writing code without an active task is FORBIDDEN.**

## Tests

A TypeScript test lives in its package's `test/`: `*.test.ts` runs in `pnpm test`; a script that runs against a real network goes in `test/live/` and runs by hand.

## Context

@lore/0-session/current-user.md
@lore/0-session/current-task.md
@lore/0-session/next-tasks.md
@lore/CLAUDE.md
