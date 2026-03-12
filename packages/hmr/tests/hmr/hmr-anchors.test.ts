import { describe, expect, it } from 'vitest'
import { createFixture } from 'fs-fixture'
import { join } from 'pathe'
import { HMRService } from '@pluxel/hmr/services/runtime/hmr/HMRService'

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
	const ctx = {
		logger: createNoopLogger(),
		on: () => noop,
		scanService: { resolveEntry: async () => ({ ok: false }) },
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
	} as unknown
	return { ctx, anchors }
}

describe('HMRService anchors', () => {
	it('treats anchors as in-scope even when excluded by default filters (tsx)', async () => {
		await using fixture = await createFixture({
			'Entry.tsx': 'export const x = 1\n',
		})
		const root = fixture.path
		const entry = join(root, 'Entry.tsx')

		const { ctx, anchors } = createCtx()
		anchors.add(entry)

		const hmr = new HMRService(ctx, { roots: [root], entries: [], exclude: [`${root}/**/*.tsx`] })
		;(hmr as unknown as { debouncer: { push: (id: string) => void } }).debouncer = { push: noop }

		const accepted = (
			hmr as unknown as { enqueueFileChange: (file: string) => boolean }
		).enqueueFileChange(entry)
		expect(accepted).toBe(true)
		expect(hmr.toolkit.pathFilter(hmr.path.toClean(entry))).toBe(false)
	})

	it('returns stable anchor snapshots across calls', async () => {
		await using fixture = await createFixture({
			'A.ts': 'export const a = 1\n',
			'B.ts': 'export const b = 1\n',
		})
		const root = fixture.path

		const { ctx, anchors } = createCtx()
		const a = join(root, 'A.ts')
		const b = join(root, 'B.ts')
		anchors.add(a)

		const hmr = new HMRService(ctx, { roots: [root], entries: [] })

		const snapshot1: ReadonlySet<string> = (
			hmr as unknown as { getAnchorsCleanSnapshot: () => ReadonlySet<string> }
		).getAnchorsCleanSnapshot()
		expect(snapshot1.has(a)).toBe(true)
		expect(snapshot1.has(b)).toBe(false)

		anchors.add(b)
		const snapshot2: ReadonlySet<string> = (
			hmr as unknown as { getAnchorsCleanSnapshot: () => ReadonlySet<string> }
		).getAnchorsCleanSnapshot()
		expect(snapshot2.has(a)).toBe(true)
		expect(snapshot2.has(b)).toBe(true)

		expect(snapshot1.has(b)).toBe(false)
	})
})
