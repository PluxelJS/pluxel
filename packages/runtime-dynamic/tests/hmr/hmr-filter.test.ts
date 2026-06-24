import { describe, expect, it } from 'vitest'
import { join, normalize, relative } from 'pathe'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import { fixturesPluginsDir, workspaceRoot } from './_paths'
import { withTestDynamicContext } from '../support/context'

const pkgRoot = workspaceRoot
const pluginDir = fixturesPluginsDir
const pluginFile = join(pluginDir, 'PluginA.ts')

describe('LoaderHmrService file filter', () => {
	it('accepts relative, absolute and /@fs watcher paths inside scan roots', async () => {
		await withTestDynamicContext((ctx) => {
			const hmr = new LoaderHmrService(ctx, {
				roots: [pluginDir],
				entries: [],
			})
			// Simulate Vite configuring server root to packages/runtime (matches real dev script)
			hmr.setServerRoot(pkgRoot)

			const filter = hmr.toolkit.pathFilter
			// Relative watcher paths are resolved against LoaderHmrService cwd (process.cwd()).
			// This test suite can be executed from either workspace root or package root, so compute it dynamically.
			const relPath = normalize(relative(process.cwd(), pluginFile))
			const cleanRel = hmr.normalizeId(relPath)

			expect(cleanRel).toBe(pluginFile)
			expect(filter(relPath)).toBe(true)
			expect(filter(pluginFile)).toBe(true)
			expect(filter(`/@fs${pluginFile}`)).toBe(true)
			expect(filter(join(pkgRoot, 'node_modules/some/pkg/index.ts'))).toBe(false)
		})
	})
})
