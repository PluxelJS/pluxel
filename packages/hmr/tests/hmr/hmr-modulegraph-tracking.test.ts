import { describe, expect, it } from 'bun:test'
import type { Context } from '@pluxel/core'
import { join } from 'pathe'
import { HMRService } from '../../src/services/runtime/hmr/HMRService'

const noop = () => undefined

const createCtx = () => {
	const anchors = new Set<string>()
	return {
		logger: { info: noop, error: noop, warn: noop },
		scanService: { resolveEntry: async () => ({ ok: false }) },
		loader: {
			api: {
				anchors: {
					has: (id: string) => anchors.has(id),
				},
			},
			pruneModule: noop,
		},
		registry: {
			commit: async () => ({ ok: true }),
			container: { services: new Map() },
		},
		honoService: { viteHonoDevServer: { name: 'noop', apply: 'serve', configureServer: noop } },
	} as unknown as Context
}

describe('HMRService dynamic moduleGraph tracking', () => {
	it('accepts changes outside scan roots if the file exists in the runner moduleGraph', async () => {
		const ctx = createCtx()
		const pkgRoot = process.cwd()
		const root = join(pkgRoot, 'tests/fixtures/plugins')
		const outside = join(pkgRoot, 'tests/fixtures/deps/Dep.ts')

		const hmr = new HMRService(ctx, { roots: [root], entries: [] })
		hmr.setServerRoot(pkgRoot)

		// Stub batching target.
		;(hmr as any).debouncer = { push: noop }

		// Simulate Vite moduleGraph knowing about this file (via /@fs variant).
		const outsideClean = hmr.normalizeId(outside)
		const outsideFs = `/@fs${outsideClean}`
		;(hmr as any).ssrEnv = {
			moduleGraph: {
				getModulesByFile: (id: string) => (id === outsideFs ? new Set([{}]) : undefined),
			},
		}

		const accepted = (hmr as any).enqueueFileChange(outside)
		expect(accepted).toBe(true)
	})
})
