# Handoff Note for Claude Code

This folder is a complete Spec-Kit feature ready for implementation by a Claude Code agent.

**Spec version: v1.1 (2026-05-14)** — incorporates the Profile Capture compliance fix (executeScript on user-click), MV3 service-worker keep-alive, manifest `scripting` permission, SC-005 alignment to ≥65 within 60 days, and TODO.md reconciliation note. See "v1.1 changes" headers in spec.md / plan.md / tasks.md.

## What this is

LinkMate v0.4.0 — pivots the extension from "AI reply suggestions" into a personal LinkedIn-brand growth co-pilot organized around the user's SSI score. Four modules: Profile Context, Engagement Queue, SSI Tracker + Dashboard, Connection Suggestor (deferred scaffolding).

The owner of this extension is also the developer; the extension's first user is themselves. Their measured baseline is SSI 18/100 and the goal is 65+ within 60 days, which directly supports landing a $150K USD remote AI Engineer role.

## Suggested first prompt to Claude Code

Open this repo in Claude Code and paste:

```
Read these in order, then begin implementation following tasks.md:

1. .specify/memory/constitution.md
2. specs/001-ssi-growth-mode/spec.md
3. specs/001-ssi-growth-mode/plan.md
4. specs/001-ssi-growth-mode/tasks.md

Constraints:
- Branch: 001-ssi-growth-mode (create from main).
- Test-first: every implementation task waits for its preceding test task.
- Run `npm run type-check && npm run lint && npm test` after each task.
- One PR per phase (A, B, C, D, E).
- NEVER programmatically click LinkedIn submit/post/send buttons. Drafts only.

Start with T000 (pre-flight). After each completed task, mark its checkbox in tasks.md and commit with a Conventional Commits message.

When you finish Phase A, stop and ask me to review before proceeding to Phase B.
```

## Why this works

- Spec Kit conventions are already in place in this repo (`.specify/templates/`, `.specify/scripts/bash/`).
- Constitution.md defines non-negotiables (Privacy-First, Quality Gates, Test-First) that bind every task.
- spec.md, plan.md, tasks.md are filled in concretely — no `[NEEDS CLARIFICATION]` placeholders.
- tasks.md gives a literal execution order with file-level granularity.

## What you (the human owner) should do during implementation

1. Review at the end of each Phase before approving the next.
2. Spot-check that no programmatic LinkedIn submit clicks slip in (search the diff for `.click()` near LinkedIn submit/post/send selectors).
3. Run the extension in a real Chrome against real LinkedIn during Phase D manual testing. Log results in `manual-test-log.md`.
4. After v0.4.0 ships, dogfood for 7 days, then revisit Phase E (Connection Suggestor v0.4.1).

## Files in this folder

- `spec.md` — what + why
- `plan.md` — how (architecture, files, storage schema, message protocol, scoring algorithm)
- `tasks.md` — atomic task list in execution order
- `HANDOFF.md` — this file

`data-model.md` and `manual-test-log.md` will be created by Claude Code during T304 and T300 respectively.
