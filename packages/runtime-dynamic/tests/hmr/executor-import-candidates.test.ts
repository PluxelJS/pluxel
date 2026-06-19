import { describe, expect, it } from 'vitest'
import '@pluxel/runtime-dynamic/register'
import { BasePlugin, createRuntimeHost, Plugin } from '@pluxel/runtime/test'
import { HmrExecutor } from '../../src/hmr/engine/pipeline'

describe('HmrExecutor import candidates', () => {
	it('prefers /@fs for filesystem ids but records canonical moduleId', async () => {
		const calls: string[] = []
		const cleanId = '/repo/plugins/a/src/index.ts'
		const host = createRuntimeHost()

		class Anchor extends BasePlugin {}
		Plugin({ name: 'Anchor' })(Anchor)

		const runner = {
			import: async (id: string) => {
				calls.push(id)
				if (id === `/@fs${cleanId}`) return { Anchor }
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

		try {
			const executor = new HmrExecutor(host.ctx, runner, path, timing, {
				useRequireShims: false,
				dbgModules: null,
			})

			const out = await executor.runAndLoadAllClean([cleanId])

			expect(calls).toEqual([`/@fs${cleanId}`])
			expect(out?.res.ok).toBe(true)
			expect(host.ctx.loader.api.anchors.has(cleanId)).toBe(true)
			expect(host.ctx.loader.api.registry.findModuleId('Anchor')).toBe(cleanId)
		} finally {
			await host.dispose()
		}
	})
})
