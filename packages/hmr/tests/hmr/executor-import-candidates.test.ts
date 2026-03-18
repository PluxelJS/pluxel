import { describe, expect, it } from 'vitest'
import { HmrExecutor } from '../../src/dev/hmr/pipeline'

describe('HmrExecutor import candidates', () => {
	it('prefers /@fs for filesystem ids but records canonical moduleId', async () => {
		const calls: string[] = []
		const cleanId = '/repo/plugins/a/src/index.ts'

		const ctx = {
			logger: {
				error: () => undefined,
				warn: () => undefined,
			},
			loader: {
				beginBatch: () => ({
					replaceModule: async (moduleId: string, _mod: unknown) => {
						expect(moduleId).toBe(cleanId)
						return true
					},
					commit: () => undefined,
					rollback: () => undefined,
				}),
			},
			registry: {
				commit: async () => ({ ok: true }),
				resetDraft: () => undefined,
			},
		} as any

		const runner = {
			import: async (id: string) => {
				calls.push(id)
				if (id === `/@fs${cleanId}`) return { default: {} }
				throw new Error(`unexpected id: ${id}`)
			},
		} as any

		const path = {
			variantsClean: (id: string) => [id, `/@fs${id}`],
			pretty: (id: string) => id,
			toClean: (id: string) => id,
			toVite: (id: string) => id,
			variants: (id: string) => [id, `/@fs${id}`],
		} as any

		const timing = {
			start: () => () => 0,
		} as any

		const executor = new HmrExecutor(ctx, runner, path, timing, {
			useRequireShims: false,
			dbgModules: null,
		})

		await executor.runAndLoadAllClean([cleanId])

		expect(calls).toEqual([`/@fs${cleanId}`])
	})
})
