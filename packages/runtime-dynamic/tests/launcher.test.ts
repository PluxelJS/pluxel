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

import { startDynamicDevRuntime } from '../src/index.ts'

describe('startDynamicDevRuntime', () => {
	beforeEach(() => {
		owned.close.mockReset().mockResolvedValue(undefined)
		const server = {
			close: owned.close,
			[Symbol.for('pluxel.dynamicRuntimeController')]: { booted: { ctx: owned.ctx } },
		}
		owned.start.mockReset().mockResolvedValue({
			server,
			origin: 'http://127.0.0.1:43123',
		})
	})

	it('returns a ready resource with a physical origin and an idempotent disposer', async () => {
		const runtime = await startDynamicDevRuntime({ entry: 'src/pluxel.dynamic.ts' })
		expect(owned.start).toHaveBeenCalledWith({
			entry: expect.stringMatching(/\/src\/pluxel\.dynamic\.ts$/),
			root: process.cwd(),
		})
		expect(runtime.ctx).toBe(owned.ctx)
		expect(runtime.origin).toBe('http://127.0.0.1:43123')
		expect(owned.start).toHaveBeenCalledOnce()
		const firstDispose = runtime.dispose()
		const secondDispose = runtime[Symbol.asyncDispose]()
		expect(secondDispose).toBe(firstDispose)
		await firstDispose
		expect(owned.close).toHaveBeenCalledOnce()
		expect(() => runtime.ctx).toThrow(/is closed/i)
	})

	it('accepts file URLs and rejects empty or non-file entries', async () => {
		const entry = new URL('./fixtures/pluxel.dynamic.ts', import.meta.url)
		await using _runtime = await startDynamicDevRuntime({ entry })
		expect(owned.start).toHaveBeenCalledWith({
			entry: expect.stringMatching(/\/fixtures\/pluxel\.dynamic\.ts$/),
			root: process.cwd(),
		})

		await expect(startDynamicDevRuntime({ entry: '' })).rejects.toThrow(/entry is required/i)
		await expect(startDynamicDevRuntime({ root: '/workspace' } as never)).rejects.toThrow(
			/entry must be/i,
		)
		await expect(
			startDynamicDevRuntime({ entry: new URL('https://example.test/runtime.ts') }),
		).rejects.toThrow(/file: protocol/i)
		await expect(
			startDynamicDevRuntime({ entry: new URL('file:///runtime.ts?generation=1') }),
		).rejects.toThrow(/query or fragment/i)
	})

	it('passes startup cancellation through without publishing a resource', async () => {
		const controller = new AbortController()
		controller.abort(new Error('cancel startup'))

		await expect(
			startDynamicDevRuntime({ entry: 'src/pluxel.dynamic.ts', signal: controller.signal }),
		).rejects.toThrow('cancel startup')
		expect(owned.start).not.toHaveBeenCalled()
	})
})
