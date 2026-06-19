import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearHmrRuntimeHandles, setHmrRuntimeHandles } from '@pluxel/runtime/internal'

import { ui, worker } from '../src/plugin'

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
		ext: {
			ui: {
				remote: {
					packaged: vi.fn(() => () => {}),
				},
			},
		},
	}

	return { root, pluginCtx }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('@pluxel/runtime/plugin', () => {
	it('ui() binds through dev handles when HMR wiring is attached', () => {
		const { root, pluginCtx } = createPluginCtx()
		const bindUiSource = vi.fn(() => () => {})

		setHmrRuntimeHandles(root, {
			extensions: {
				bindUiSource,
			},
		})

		const declaration = ui('./ui/index.tsx')
		const dispose = declaration.bind(pluginCtx)

		expect(bindUiSource).toHaveBeenCalledWith(pluginCtx, {
			entryPath: './ui/index.tsx',
		})
		expect(typeof dispose).toBe('function')
		clearHmrRuntimeHandles(root)
	})

	it('ui() falls back to packaged runtime registration outside HMR', () => {
		const { pluginCtx } = createPluginCtx()

		const declaration = ui('./ui/index.tsx')
		const dispose = declaration.bind(pluginCtx)

		expect(pluginCtx.ext.ui.remote.packaged).toHaveBeenCalledTimes(1)
		expect(pluginCtx.ext.ui.remote.packaged).toHaveBeenCalledWith()
		expect(typeof dispose).toBe('function')
	})

	it('worker() falls back cleanly when no dev bundler is attached', async () => {
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

	it('worker() uses root-scoped dev handles and tracks HMR updates', async () => {
		const { root, pluginCtx } = createPluginCtx()
		const onUpdate = vi.fn()
		const stopWatching = vi.fn(async () => {})
		const watchTinypoolWorker = vi.fn(async (_ctx, _entry, options) => {
			await options.onUpdate('file:///tmp/hmr-worker.mjs')
			return stopWatching
		})

		setHmrRuntimeHandles(root, {
			bundler: {
				watchTinypoolWorker,
			},
		})

		const binding = await worker('./ui/worker.ts').bind(pluginCtx, { onUpdate })

		expect(watchTinypoolWorker).toHaveBeenCalledWith(
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
		clearHmrRuntimeHandles(root)
	})
})
