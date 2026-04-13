import { fileURLToPath } from 'node:url'

// `packages/hmr/`
export const hmrPkgRoot = fileURLToPath(new URL('../../', import.meta.url))

// Workspace root (`/home/.../pluxel/`) — do not depend on `process.cwd()` in tests.
export const workspaceRoot = fileURLToPath(new URL('../../../../', import.meta.url))

// Fixtures relative to `packages/hmr/`
export const fixturesPluginsRelFromHmr = 'tests/fixtures/plugins'
export const fixturesDepsRelFromHmr = 'tests/fixtures/deps'

// Fixtures relative to workspace root.
export const fixturesPluginsRelFromWorkspace = 'packages/hmr/tests/fixtures/plugins'
export const fixturesDepsRelFromWorkspace = 'packages/hmr/tests/fixtures/deps'

export const fixturesPluginsDir = fileURLToPath(new URL(`../fixtures/plugins/`, import.meta.url))
export const fixturesDepsDir = fileURLToPath(new URL(`../fixtures/deps/`, import.meta.url))
