// Type-only import: ensure @pluxel/hmr/services module augmentations are loaded
// whenever users import from `@pluxel/hmr/web/react`.
import type {} from '../services'

export * from '@pluxel/hmr-web/react'
