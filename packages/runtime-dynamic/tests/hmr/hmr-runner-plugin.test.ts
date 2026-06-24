import { describe, expect, it } from 'vitest'
import { join } from 'pathe'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import { fixturesPluginsRelFromWorkspace, workspaceRoot } from './_paths'
import { withTestDynamicContext } from '../support/context'

describe('LoaderHmrService runner plugin', () => {
	it('does not suppress Vite hot updates for the client UI', async () => {
		const cwd = workspaceRoot
		await withTestDynamicContext((ctx) => {
			const hmr = new LoaderHmrService(ctx, {
				roots: [join(cwd, fixturesPluginsRelFromWorkspace)],
				entries: [],
			})

			const plugin = (hmr as unknown as { plugin: { handleHotUpdate?: unknown } }).plugin
			expect(plugin.handleHotUpdate).toBeUndefined()
		})
	})
})
