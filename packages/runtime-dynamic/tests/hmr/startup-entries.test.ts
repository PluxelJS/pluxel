import { describe, expect, it } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'
import { BasePlugin, Plugin } from '@pluxel/test'
import { join } from 'pathe'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import { withTestDynamicContext } from '../support/context'

describe('LoaderHmrService entries', () => {
	it('uses entries as the cold-start entry list', async () => {
		await using fixture = await createFixture({
			'A.ts': 'export const a = 1\n',
			'B.ts': 'export const b = 1\n',
		})
		const root = fixture.path
		const a = join(root, 'A.ts')
		const b = join(root, 'B.ts')

		class StartupAnchor extends BasePlugin {}
		Plugin({ name: 'StartupAnchor' })(StartupAnchor)

		await withTestDynamicContext(async (ctx) => {
			await ctx.loader.replaceModule(b, { StartupAnchor })
			ctx.scanService.listWorkspaceEntries = () => {
				throw new Error('scanService should not be called when entries is provided')
			}
			ctx.scanService.resolveEntry = async () => {
				throw new Error('scanService.resolveEntry should not be called when entries is provided')
			}

			const hmr = new LoaderHmrService(ctx, { roots: [root], entries: [a] })

			const scope = await (
				hmr as unknown as { ensureStartupScope: () => Promise<{ entryList: string[] }> }
			).ensureStartupScope()
			expect(scope.entryList).toContain(a)
			expect(scope.entryList).toContain(b) // anchors always included
		})
	})
})
