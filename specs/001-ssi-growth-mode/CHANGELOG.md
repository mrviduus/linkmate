# Spec Changelog

## v1.1 — 2026-05-14

Source: review by implementing Claude Code agent against v1.0 spec, surfacing 5 prioritized recommendations + 2 pre-existing repo bugs.

### Changes accepted

1. **Profile Capture compliance fix.** v1.0 had a registered content script on `linkedin.com/in/*` plus background-tab creation, which contradicted Compliance Constraint #2 ("no headless or invisible interactions with LinkedIn UI beyond read-only DOM parsing of pages the user has already loaded"). v1.1 replaces this with `chrome.scripting.executeScript` triggered by an explicit user click in the popup, with an active-tab URL guard ensuring the user is on their own profile.
   - spec.md: User Story 3 rewritten, FR-001..FR-006 rewritten, Compliance #2 amended with explicit Profile Capture carve-out.
   - plan.md: architecture diagram updated; Profile Capture Flow section added; manifest changes section updated (`scripting` permission added, no `/in/*` content_scripts entry).
   - tasks.md: T030–T038 rewritten; T039 added (manifest update); compliance note added at top of US3 task block.

2. **MV3 service-worker keep-alive.** v1.0 SSI Capture Flow assumed the SW would remain alive across tab create + page load + content-script parse + message arrival. In MV3 the SW suspends after ~30s idle, which loses the message in slow-network scenarios.
   - plan.md: SSI Capture Flow rewritten to wrap in `keepAlive.start()` / `keepAlive.stop()`. New "MV3 service-worker keep-alive" subsection. Risk row added.
   - tasks.md: T015–T016 added (test + impl of `src/keep-alive.ts`); T211 updated to call keep-alive helpers; T214 added (manual integration test under throttled network).

3. **SC-005 / HANDOFF / 6-week timeline alignment.** v1.0 SC-005 said "≥60 within 60 days" but HANDOFF.md and the broader career-pivot conversation said "65+". Aligned to ≥65 within 60 days.
   - spec.md: SC-005 updated.

4. **TODO.md reconciliation.** v1.0 T303 said "mark Reply Tone Selector etc. as in-progress in TODO.md" without acknowledging that TODO.md was partially stale. v1.1 T303 specifies what to mark IMPLEMENTED, IN PROGRESS, DEFERRED, with cross-reference instruction.
   - tasks.md: T303 rewritten.
   - spec.md: References section softened on TODO.md.

5. **Profile Capture permission strategy.** Documented in plan.md "Profile Capture Flow" — explicit reasoning for `chrome.scripting.executeScript` over a registered content script, and active-tab URL guard pattern.

### Pre-existing repo bugs surfaced (not in this feature's scope)

These are noted here for visibility but should be tracked separately. They are not fixed in this branch.

- **`.specify/memory/constitution.md` is stale.** Version 1.0.0 ratified 2025-10-13. Currently 2026-05-14. Constitution declares "Test suite pass (132+ tests)" as a quality gate, but recent test cleanup (`hello-world.test.ts`, `content.test.ts` removed) means the actual count is lower. Either:
  - Amend Constitution to drop the specific number ("All tests must pass" suffices), or
  - Re-baseline the number against current state.
  Recommend amending — the specific count was always going to drift.

- **ESLint TS parser not configured.** `Constitution IV` requires "ESLint with TypeScript parser", and `@typescript-eslint/parser` is in devDependencies, but `.eslintrc.json` does not enable it. Currently `npm run lint` only lints `src/**/*.js` (none of the actual TypeScript code). Either:
  - Enable `@typescript-eslint/parser` in `.eslintrc.json` and broaden the lint glob to `src/**/*.{ts,js}`, or
  - Amend Constitution IV to match the current reality (TS coverage delegated to `npm run type-check` only).
  Recommend the former — silent constitutional violation is worse than the small migration effort.

Both should be addressed before or in parallel with this feature so the Constitution gate is meaningful when invoked in `tasks.md` (T305).
