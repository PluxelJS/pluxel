import { fileURLToPath } from 'node:url'

import { dirname, resolve } from 'pathe'

const here = dirname(fileURLToPath(import.meta.url))

export const repoRoot = resolve(here, '../../../..')
export const runtimeEntry = resolve(repoRoot, 'packages/runtime/dist/index.mjs')
export const runtimeFrozenEntry = resolve(repoRoot, 'packages/runtime/dist/frozen.mjs')
