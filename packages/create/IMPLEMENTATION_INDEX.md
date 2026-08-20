# @pluxel/create — Implementation Index

- `src/create.ts`: typed argument parsing, safe staged copy, optional pnpm install and diagnostics.
- `tsdown.config.ts`: owns the npm CLI bin mapping, emits one Node 24 ESM executable, and copies
  `template/` plus repository `docs/` into `dist/`.
- `template/`: fixed, interpolation-free example monorepo source.
- `tests/create.test.mjs`: destination behavior and byte-for-byte documentation unit tests.
- `scripts/smoke-starter.ts`: packed external install, workspace verification, static distribution and
  unified static/dynamic Vite integration smoke.

There is deliberately no shared scaffold library or dependency edge to `@pluxel/cli`.
