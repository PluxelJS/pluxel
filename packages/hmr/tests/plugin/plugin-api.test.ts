import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { clearDevRuntimeHandles, setDevRuntimeHandles } from '@pluxel/runtime/internal'

import { ui, worker } from '../../src/plugin'

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
		loader: {
			api: {
				registry: {
					findModuleIdByName: vi.fn(() => '/tmp/demo-plugin/index.ts'),
				},
			},
		},
		ext: {
			ui: {
				bindModule: vi.fn(() => () => undefined),
			},
		},
	}

	return { root, pluginCtx }
}

afterEach(() => {
	vi.restoreAllMocks()
})

describe('@pluxel/hmr/plugin', () => {
	it('ui() binds through the runtime UI sink', () => {
		const { pluginCtx } = createPluginCtx()

		const declaration = ui('./ui/index.tsx')
		const dispose = declaration.bind(pluginCtx)

		expect(pluginCtx.ext.ui.bindModule).toHaveBeenCalledWith({
			entryPath: './ui/index.tsx',
		})
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

	it('worker() uses root-scoped dev handles and tracks HMR updates', async () => {
		const { root, pluginCtx } = createPluginCtx()
		const onUpdate = vi.fn()
		const stopWatching = vi.fn(async () => undefined)
		const watchTinypoolWorker = vi.fn(async (_ctx, _entry, options) => {
			await options.onUpdate('file:///tmp/hmr-worker.mjs')
			return stopWatching
		})

		setDevRuntimeHandles(root, {
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
		clearDevRuntimeHandles(root)
	})
})
