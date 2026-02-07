import { describe, expect, it } from 'vitest'
import { createFixture } from 'fs-fixture'
import { join } from 'pathe'
import { HMRService } from '../../src/services/runtime/hmr/HMRService'

const noop = () => undefined

function createNoopLogger() {
	const self: any = {
		trace: noop,
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		fatal: noop,
		with: () => self,
	}
	return {
		...self,
		getDebugChannel: () => self,
	}
}

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
		on: () => noop,
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
		honoService: { viteHonoDevServer: { name: 'noop', apply: 'serve', configureServer: noop } },
		scanService,
	} as unknown

	return { ctx, anchors }
}

describe('HMRService entries', () => {
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

		const hmr = new HMRService(ctx, { roots: [root], entries: [a] })

		const scope = await (hmr as unknown as { ensureStartupScope: () => Promise<{ entryList: string[] }> }).ensureStartupScope()
		expect(scope.entryList).toContain(a)
		expect(scope.entryList).toContain(b) // anchors always included
	})
})
