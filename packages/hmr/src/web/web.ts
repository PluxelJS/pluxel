// Type-only import: ensure @pluxel/hmr/services module augmentations are loaded
// whenever users import from `@pluxel/hmr/web`.
import type {} from '../services'

export * from '@pluxel/hmr-web'

// Ergonomic aliases
export { createHmrWebClient as createHmrClient, hmrWebClient as hmr } from '@pluxel/hmr-web'
