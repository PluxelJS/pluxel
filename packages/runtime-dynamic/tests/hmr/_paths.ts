import { fileURLToPath } from 'node:url'

// `packages/runtime-dynamic/`
export const hmrPkgRoot = fileURLToPath(new URL('../../', import.meta.url))

// Workspace root (`/home/.../pluxel/`) — do not depend on `process.cwd()` in tests.
export const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))

// Fixtures relative to `packages/runtime-dynamic/`
export const fixturesPluginsRelFromHmr = 'tests/fixtures/plugins'
export const fixturesDepsRelFromHmr = 'tests/fixtures/deps'

// Fixtures relative to workspace root.
export const fixturesPluginsRelFromWorkspace = 'packages/runtime-dynamic/tests/fixtures/plugins'
export const fixturesDepsRelFromWorkspace = 'packages/runtime-dynamic/tests/fixtures/deps'

export const fixturesPluginsDir = fileURLToPath(new URL(`../fixtures/plugins/`, import.meta.url))
export const fixturesDepsDir = fileURLToPath(new URL(`../fixtures/deps/`, import.meta.url))
