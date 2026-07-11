import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { worker } from '../src/plugin'
import { ui } from '../src/web-management/ui'
import * as runtimeAuthoring from '../src/index'
import * as pluginAuthoring from '../src/plugin'
import { requireWebManagement } from '../src/services/web-management/WebManagementService'

function createPluginCtx() {
	const root: any = {
		effects: {
			defer: (fn: () => void | Promise<void>) => ({ dispose: fn }),
		},
	}
	root.root = root

	const pluginCtx: any = {
		root,
		effects: {
			defer: (fn: () => void | Promise<void>) => ({ dispose: fn }),
		},
		pluginInfo: { id: 'DemoPlugin' },
		registry: {
			getRuntimeModuleId: vi.fn(() => undefined),
		},
		loader: {
			api: {
				registry: {
					findModuleIdByName: vi.fn(() => '/tmp/demo-plugin/index.ts'),
				},
			},
		},
	}

	return { root, pluginCtx }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('@pluxel/runtime author declarations', () => {
	it('keeps removed mutation and UI APIs out of default author entries', () => {
		for (const removed of [
			'__registerConfigBinding__',
			'__registerConfigSchema__',
			'__registerUsedFeatures__',
			'__setConfigLayout__',
			'__setConfigSource__',
			'UseFeature',
		]) {
			expect(runtimeAuthoring).not.toHaveProperty(removed)
		}
		expect(pluginAuthoring).not.toHaveProperty('ui')
	})

	it('exposes only the optional Web Management gate on plugin contexts', async () => {
		const { createRuntimeContext } = await import('../src/test')
		const runtime = createRuntimeContext()
		try {
			expect(runtime.ctx.webManagement.enabled).toBe(true)
			expect(typeof runtime.ctx.webManagement.use).toBe('function')
			expect(runtime.ctx.webManagement).not.toHaveProperty('require')
			expect(runtime.ctx.webManagement).not.toHaveProperty('install')
		} finally {
			await runtime.dispose()
		}
	})

	it('keeps Web Management service contexts isolated while sharing host registries', async () => {
		const { createRuntimeContext } = await import('../src/test')
		const runtime = createRuntimeContext()
		try {
			const first = runtime.ctx.extend({ name: 'first-plugin' })
			const second = runtime.ctx.extend({ name: 'second-plugin' })
			Object.defineProperty(first, 'pluginInfo', {
				value: { id: 'FirstPlugin' },
				configurable: true,
			})
			Object.defineProperty(second, 'pluginInfo', {
				value: { id: 'SecondPlugin' },
				configurable: true,
			})

			const firstServices = requireWebManagement(first)
			const secondServices = requireWebManagement(second)

			expect((firstServices.rpc as unknown as { ctx: unknown }).ctx).toBe(first)
			expect((secondServices.rpc as unknown as { ctx: unknown }).ctx).toBe(second)
			expect(firstServices.rpc).not.toBe(secondServices.rpc)

			firstServices.rpc.expose(() => ({}) as never)
			expect(secondServices.rpc.getNamespaces()).toContain('FirstPlugin')
			expect((firstServices.rpc as unknown as { ctx: unknown }).ctx).toBe(first)
		} finally {
			await runtime.dispose()
		}
	})

	it('ui() creates a pure source declaration', () => {
		const declaration = ui('./ui/index.tsx')
		expect(declaration).toEqual({ entryPath: './ui/index.tsx' })
		expect(Object.isFrozen(declaration)).toBe(true)
		expect('bind' in declaration).toBe(false)
	})

	it('ui() resolves an entry relative to its declaring module', () => {
		expect(ui('file:///tmp/demo-plugin/src/index.ts', './ui/index.tsx')).toEqual({
			entryPath: '/tmp/demo-plugin/src/ui/index.tsx',
		})
	})

	it('worker() falls back cleanly when no HMR bundler is attached', async () => {
		const { pluginCtx } = createPluginCtx()
		const onUpdate = vi.fn()

		const binding = await worker('./ui/worker.ts', {
			fallback: './dist/worker.mjs',
		}).bind(pluginCtx, { onUpdate })

		expect(onUpdate).toHaveBeenCalledWith({
			mode: 'fallback',
			url: pathToFileURL('/tmp/demo-plugin/dist/worker.mjs').href,
		})
		expect(binding.snapshot()).toEqual({
			mode: 'fallback',
			url: pathToFileURL('/tmp/demo-plugin/dist/worker.mjs').href,
		})
	})

	it('worker() resolves fallback paths from core runtime module ownership first', async () => {
		const { pluginCtx } = createPluginCtx()
		pluginCtx.registry.getRuntimeModuleId.mockReturnValue('/tmp/core-plugin/index.ts')
		const onUpdate = vi.fn()

		await worker('./ui/worker.ts', {
			fallback: './dist/worker.mjs',
		}).bind(pluginCtx, { onUpdate })

		expect(onUpdate).toHaveBeenCalledWith({
			mode: 'fallback',
			url: pathToFileURL('/tmp/core-plugin/dist/worker.mjs').href,
		})
		expect(pluginCtx.loader.api.registry.findModuleIdByName).not.toHaveBeenCalled()
	})

	it('worker() uses runtime dev capability and tracks HMR updates', async () => {
		const { root, pluginCtx } = createPluginCtx()
		const onUpdate = vi.fn()
		const stopWatching = vi.fn(async () => {})
		const watch = vi.fn(async (_ctx, _entry, options) => {
			await options.onUpdate('file:///tmp/hmr-worker.mjs')
			return stopWatching
		})

		root.runtimeDev = {
			worker: { watch },
		}

		const binding = await worker('./ui/worker.ts').bind(pluginCtx, { onUpdate })

		expect(watch).toHaveBeenCalledWith(
			pluginCtx,
			'./ui/worker.ts',
			expect.objectContaining({
				onError: undefined,
				external: [],
			}),
		)
		expect(onUpdate).toHaveBeenCalledWith({
			mode: 'hmr',
			url: 'file:///tmp/hmr-worker.mjs',
		})
		expect(binding.snapshot()).toEqual({
			mode: 'hmr',
			url: 'file:///tmp/hmr-worker.mjs',
		})

		await binding.dispose()
		expect(stopWatching).toHaveBeenCalledTimes(1)
	})
})
