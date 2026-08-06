import { beforeEach, describe, expect, it, vi } from 'vitest'

const host = vi.hoisted(() => ({
	start: vi.fn<() => Promise<void>>(),
	stop: vi.fn<() => Promise<void>>(),
	ctx: { marker: 'ctx' },
}))

vi.mock('../src/hmr/host.ts', () => ({
	planLoaderHmrHostFromConfig: vi.fn(async () => ({ marker: 'plan' })),
	bootPlannedLoaderHmrHost: vi.fn(async () => ({
		ctx: host.ctx,
		hmr: { start: host.start },
		stop: host.stop,
	})),
}))

import { createDynamicDevRuntime } from '../src/index.ts'

describe('createDynamicDevRuntime', () => {
	beforeEach(() => {
		host.start.mockReset().mockResolvedValue(undefined)
		host.stop.mockReset().mockResolvedValue(undefined)
	})

	it('starts HMR before publishing the runtime context', async () => {
		const runtime = await createDynamicDevRuntime({ root: '/workspace' })
		expect(() => runtime.ctx).toThrow(/has not started/i)

		await runtime.start()

		expect(host.start).toHaveBeenCalledOnce()
		expect(runtime.ctx).toBe(host.ctx)
		await runtime.stop()
		expect(host.stop).toHaveBeenCalledOnce()
		expect(() => runtime.ctx).toThrow(/has stopped/i)
		await expect(runtime.start()).rejects.toThrow(/cannot start a stopped runtime/i)
	})

	it('cleans up a partially booted host when HMR startup fails', async () => {
		host.start.mockRejectedValueOnce(new Error('watcher failed'))
		const runtime = await createDynamicDevRuntime({ root: '/workspace' })

		await expect(runtime.start()).rejects.toThrow('watcher failed')
		expect(host.stop).toHaveBeenCalledOnce()
		expect(() => runtime.ctx).toThrow(/has not started/i)
	})

	it('validates direct-launcher config instead of exposing low-level host context', async () => {
		await expect(
			createDynamicDevRuntime({ root: '/workspace', context: {} } as never),
		).rejects.toThrow(/unsupported "context"/i)
		await expect(
			createDynamicDevRuntime({
				root: '/workspace',
				storage: { persistenceDir: '', obsoleteStateFile: 'state.json' },
			} as never),
		).rejects.toThrow(/unsupported "obsoleteStateFile"/i)
	})
})
