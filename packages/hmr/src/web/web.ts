/**
 * Web SDK (browser/React).
 *
 * Public entry: `@pluxel/hmr/web`.
 *
 * Implementation lives in the internal (private) package `@pluxel/hmr-web` to avoid
 * `@pluxel/components` ↔ `@pluxel/hmr` dependency cycles. During `@pluxel/hmr` build,
 * we vendor `@pluxel/hmr-web` into this entry (tsdown `noExternal`) and rewrite
 * generated `.d.ts` so external consumers only see `@pluxel/hmr/web`.
 */

export * from '@pluxel/hmr-web'
