import { describe, expect, it } from 'vitest'
import { join, normalize, relative } from 'pathe'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import { fixturesPluginsDir, workspaceRoot } from './_paths'
import { withTestDynamicContext } from '../support/context'

describe('LoaderHmrService file filter', () => {
	it('accepts relative, absolute and /@fs watcher paths inside scan roots', async () => {
		await withTestDynamicContext((ctx) => {
			const pluginFile = join(fixturesPluginsDir, 'PluginA.ts')
			const hmr = new LoaderHmrService(ctx, { roots: [fixturesPluginsDir], entries: [] })
			hmr.setServerRoot(workspaceRoot)

			const relativePath = normalize(relative(process.cwd(), pluginFile))
			expect(hmr.normalizeId(relativePath)).toBe(pluginFile)
			expect([
				hmr.toolkit.pathFilter(relativePath),
				hmr.toolkit.pathFilter(pluginFile),
				hmr.toolkit.pathFilter(`/@fs${pluginFile}`),
				hmr.toolkit.pathFilter(join(workspaceRoot, 'node_modules/pkg/index.ts')),
			]).toEqual([true, true, true, false])
		})
	})
})
