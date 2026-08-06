import { beforeEach, describe, expect, it, vi } from 'vitest'

const owned = vi.hoisted(() => {
	const ctx = { marker: 'ctx' }
	return {
		ctx,
		close: vi.fn<() => Promise<void>>(),
		start: vi.fn<() => Promise<unknown>>(),
	}
})

vi.mock('../src/launcher-internal.ts', () => ({
	startOwnedDynamicRuntimeViteServer: owned.start,
}))

import { createDynamicDevRuntime } from '../src/index.ts'

describe('createDynamicDevRuntime', () => {
	beforeEach(() => {
		owned.close.mockReset().mockResolvedValue(undefined)
		const server = {
			close: owned.close,
			[Symbol.for('pluxel.dynamicRuntimeController')]: { booted: { ctx: owned.ctx } },
		}
		owned.start.mockReset().mockResolvedValue(server)
	})

	it('loads a config module through the owned Vite route before publishing Context', async () => {
		const runtime = await createDynamicDevRuntime({ config: 'src/pluxel.dynamic.ts' })
		expect(() => runtime.ctx).toThrow(/has not started/i)

		await runtime.start()

		expect(owned.start).toHaveBeenCalledWith({ config: 'src/pluxel.dynamic.ts' })
		expect(runtime.ctx).toBe(owned.ctx)
		await runtime.start()
		expect(owned.start).toHaveBeenCalledOnce()
		await runtime.stop()
		expect(owned.close).toHaveBeenCalledOnce()
		expect(() => runtime.ctx).toThrow(/has stopped/i)
		await expect(runtime.start()).rejects.toThrow(/cannot start a stopped runtime/i)
	})

	it('rejects object configs and empty module paths', async () => {
		await expect(createDynamicDevRuntime({ config: '' })).rejects.toThrow(/config is required/i)
		await expect(createDynamicDevRuntime({ root: '/workspace' } as never)).rejects.toThrow(
			/config is required/i,
		)
	})
})
