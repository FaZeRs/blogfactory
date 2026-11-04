# Staged blog engine

`server/src/engine/` holds the staged generation engine behind the `normal` and `deep` modes
(research, brief, draft, gates, revise, deliver). Fast mode does not use it.

- Spec: `docs/superpowers/specs/2026-11-03-blog-engine-design.md`.
- Ported from the Lindevo content engine; keep tests with the code.
- Ported tests are `bun:test` files named `*.test.ts`; `npm run test:server` runs them with `bun test src/engine`.
- Draft-only: no stage publishes.
