import { describe, expect, it } from 'vitest'
import { join } from 'pathe'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import { GraphTools } from '../../src/hmr/engine/pipeline'
import {
	fixturesDepsRelFromWorkspace,
	fixturesPluginsRelFromWorkspace,
	workspaceRoot,
} from './_paths'
import { withTestDynamicContext } from '../support/context'
import { inspectLoaderHmr } from '../support/white-box'

const noop = () => {}

describe('LoaderHmrService dynamic moduleGraph tracking', () => {
	it('accepts changes outside scan roots if the file exists in the runner moduleGraph', async () => {
		await withTestDynamicContext((ctx) => {
			const pkgRoot = workspaceRoot
			const root = join(pkgRoot, fixturesPluginsRelFromWorkspace)
			const outside = join(pkgRoot, fixturesDepsRelFromWorkspace, 'Dep.ts')

			const hmr = new LoaderHmrService(ctx, { roots: [root], entries: [] })
			hmr.setServerRoot(pkgRoot)
			const hmrBox = inspectLoaderHmr(hmr)

			// Stub batching target.
			hmrBox.debouncer = { push: noop }

			// Simulate Vite moduleGraph knowing about this file (via /@fs variant).
			const outsideClean = hmr.normalizeId(outside)
			const outsideFs = `/@fs${outsideClean}`
			hmrBox.ssrEnv = {
				moduleGraph: {
					getModulesByFile: (id: string) => (id === outsideFs ? new Set([{}]) : undefined),
				},
			}

			const accepted = hmrBox.enqueueFileChange(outside)
			expect(accepted).toBe(true)
		})
	})

	it('walks from an out-of-scope dependency to its source-owned importer', () => {
		const outside = '/workspace/shared/value.ts'
		const inside = '/workspace/plugins/Plugin.ts'
		const insideNode = { id: inside, importers: new Set() }
		const outsideNode = { id: outside, importers: new Set([insideNode]) }
		const graph = new GraphTools(
			{
				moduleGraph: {
					getModulesByFile: (id: string) => (id === outside ? new Set([outsideNode]) : undefined),
					getModuleById: () => undefined,
				},
			} as never,
			{
				toClean: (id: string) => id,
				variants: (id: string) => [id],
				variantsClean: (id: string) => [id],
			} as never,
			(id) => id === inside,
		)

		const batch = graph.collectBatchGraph([outside])

		expect([...batch.affectedIds]).toEqual([inside])
		expect(batch.roots).toEqual([inside])
		expect(batch.distance.get(inside)).toBe(1)
	})
})
