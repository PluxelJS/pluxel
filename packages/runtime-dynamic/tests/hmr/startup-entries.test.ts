import { describe, expect, it } from 'vitest'
import { createFixture } from '@pluxel/test/fixtures'
import { join } from 'pathe'
import { LoaderHmrService } from '../../src/hmr/engine/LoaderHmrService'
import { createEventContextStub, createNoopLogger, noop } from './_stubs'

const createCtx = () => {
	const anchors = new Set<string>()
	const scanService = {
		listWorkspaceEntries: () => {
			throw new Error('scanService should not be called when entries is provided')
		},
		resolveEntry: async () => {
			throw new Error('scanService.resolveEntry should not be called when entries is provided')
		},
	} as unknown

	const ctx = {
		logger: createNoopLogger(),
		...createEventContextStub(),
		loader: {
			api: {
				anchors: {
					has: (id: string) => anchors.has(id),
					list: () => anchors.values(),
					snapshot: () => new Set(anchors),
					remove: (id: string) => anchors.delete(id),
				},
			},
		},
		registry: {
			commit: async () => ({ ok: true }),
			container: { services: new Map() },
		},
		http: { vitePlugin: { name: 'noop', apply: 'serve', configureServer: noop } },
		scanService,
	} as unknown

	return { ctx, anchors }
}

describe('LoaderHmrService entries', () => {
	it('uses entries as the cold-start entry list', async () => {
		await using fixture = await createFixture({
			'A.ts': 'export const a = 1\n',
			'B.ts': 'export const b = 1\n',
		})
		const root = fixture.path
		const a = join(root, 'A.ts')
		const b = join(root, 'B.ts')

		const { ctx, anchors } = createCtx()
		anchors.add(b)

		const hmr = new LoaderHmrService(ctx, { roots: [root], entries: [a] })

		const scope = await (
			hmr as unknown as { ensureStartupScope: () => Promise<{ entryList: string[] }> }
		).ensureStartupScope()
		expect(scope.entryList).toContain(a)
		expect(scope.entryList).toContain(b) // anchors always included
	})
})
