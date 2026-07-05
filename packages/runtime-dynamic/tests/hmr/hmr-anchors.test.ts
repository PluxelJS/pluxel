import { describe, expect, it } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'
import { BasePlugin, Plugin } from '@pluxel/test'
import { join } from 'pathe'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import { withTestDynamicContext } from '../support/context'
import { inspectLoaderHmr } from '../support/white-box'

const noop = () => {}

describe('LoaderHmrService anchors', () => {
	it('treats anchors as in-scope even when excluded by default filters (tsx)', async () => {
		await using fixture = await createFixture({
			'Entry.tsx': 'export const x = 1\n',
		})
		const root = fixture.path
		const entry = join(root, 'Entry.tsx')

		class EntryPlugin extends BasePlugin {}
		Plugin({ name: 'EntryPlugin' })(EntryPlugin)

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

	it('returns stable anchor snapshots across calls', async () => {
		await using fixture = await createFixture({
			'A.ts': 'export const a = 1\n',
			'B.ts': 'export const b = 1\n',
		})
		const root = fixture.path

		const a = join(root, 'A.ts')
		const b = join(root, 'B.ts')

		class AnchorA extends BasePlugin {}
		Plugin({ name: 'AnchorA' })(AnchorA)

		class AnchorB extends BasePlugin {}
		Plugin({ name: 'AnchorB' })(AnchorB)

		await withTestDynamicContext(async (ctx) => {
			await ctx.loader.replaceModule(a, { AnchorA })

			const hmr = new LoaderHmrService(ctx, { roots: [root], entries: [] })
			const hmrBox = inspectLoaderHmr(hmr)

			const snapshot1 = hmrBox.getAnchorsCleanSnapshot()
			expect(snapshot1.has(a)).toBe(true)
			expect(snapshot1.has(b)).toBe(false)

			await ctx.loader.replaceModule(b, { AnchorB })
			const snapshot2 = hmrBox.getAnchorsCleanSnapshot()
			expect(snapshot2.has(a)).toBe(true)
			expect(snapshot2.has(b)).toBe(true)

			expect(snapshot1.has(b)).toBe(false)
		})
	})
})
