import { describe, expect, it } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'
import { BasePlugin, Plugin } from '@pluxel/test'
import { join } from 'pathe'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import { withTestDynamicContext } from '../support/context'
import { lowerTestPlugin } from '../support/lowered-plugin'
import { inspectLoaderHmr } from '../support/white-box'

const noop = () => {}

describe('LoaderHmrService anchors', () => {
	it('treats anchors as in-scope even when excluded by default filters (tsx)', async () => {
		await using fixture = await createFixture({
			'Entry.tsx': 'export const x = 1\n',
		})
		const root = fixture.path
		const entry = join(root, 'Entry.tsx')

		@Plugin({ displayName: 'Entry' })
		class EntryPlugin extends BasePlugin {}
		lowerTestPlugin(EntryPlugin)

		await withTestDynamicContext(async (ctx) => {
			await ctx.loader.replaceModule(entry, { EntryPlugin })

			const hmr = new LoaderHmrService(ctx, {
				roots: [root],
				entries: [],
				exclude: [`${root}/**/*.tsx`],
			})
			const hmrBox = inspectLoaderHmr(hmr)
			hmrBox.debouncer = { push: noop }

			const accepted = hmrBox.enqueueFileChange(entry)
			expect(accepted).toBe(true)
			expect(hmr.toolkit.pathFilter(hmr.path.toClean(entry))).toBe(false)
		})
	})

	it('keeps anchor snapshots immutable and merges explicit cold-start entries without scanning', async () => {
		await using fixture = await createFixture({ A: '', B: '', Entry: '' })
		const a = join(fixture.path, 'A')
		const b = join(fixture.path, 'B')
		const entry = join(fixture.path, 'Entry')
		@Plugin({ displayName: 'Anchor A' })
		class AnchorA extends BasePlugin {}
		lowerTestPlugin(AnchorA)
		@Plugin({ displayName: 'Anchor B' })
		class AnchorB extends BasePlugin {}
		lowerTestPlugin(AnchorB)

		await withTestDynamicContext(async (ctx) => {
			await ctx.loader.replaceModule(a, { AnchorA })
			const hmr = new LoaderHmrService(ctx, { roots: [fixture.path], entries: [entry] })
			const hmrBox = inspectLoaderHmr(hmr)
			const before = hmrBox.getAnchorsCleanSnapshot()
			await ctx.loader.replaceModule(b, { AnchorB })

			expect([...before]).toEqual([a])
			expect([...hmrBox.getAnchorsCleanSnapshot()]).toEqual([a, b])

			ctx.scanService.listWorkspaceEntries = () => {
				throw new Error('explicit entries must bypass workspace scanning')
			}
			ctx.scanService.resolveEntry = async () => {
				throw new Error('explicit entries must bypass entry resolution')
			}
			const startup = await hmrBox.ensureStartupScope()
			expect(new Set(startup.entryList)).toEqual(new Set([entry, a, b]))
		})
	})
})
