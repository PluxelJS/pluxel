import { createFixture } from '@pluxel/test/fixtures'
import { createRuntimeContext } from '@pluxel/runtime/test'
import { describe, expect, it, vi } from 'vitest'

import { installLoaderHmr, type LoaderHmrWorkspaceSnapshot } from '@pluxel/runtime-dynamic/hmr'
import {
	getHmrRuntimeHandles,
	getRuntimeModuleAdapter,
	hasRuntimeModuleAdapter,
} from '@pluxel/runtime/internal'

describe('@pluxel/runtime-dynamic/hmr installLoaderHmr', () => {
	it('attaches HMR to an existing Context', async () => {
		await using fixture = await createFixture({
			'packages/a/src/index.ts': 'export const entry = "a"\n',
		})
		vi.stubEnv('PLUXEL_HMR_PORT', '0')

		const snapshot: LoaderHmrWorkspaceSnapshot = {
			activeProfile: 'dev',
			roots: ['packages/a'],
			enabled: ['pluxel-plugin-a'],
			builtinPackages: [],
			enabledEntries: ['packages/a/src/index.ts'],
			includedEntries: [],
			watchRoots: ['packages/a'],
			includeGlobs: [],
			excludeGlobs: [],
		}

		const runtime = createRuntimeContext({
			configService: { mode: 'memory' },
			pluginData: { enabled: false },
			packageService: { state: { enabled: false } },
			http: {
				uiAssets: 'disabled',
				controlPlane: { web: false, rpc: false, sse: false },
			},
			extensionService: { enabled: false },
		})
		const ctx = runtime.ctx
		const res = await installLoaderHmr(ctx, {
			cwd: fixture.path,
			snapshot,
			warmup: false,
			printUrls: false,
		})

		expect(hasRuntimeModuleAdapter(ctx)).toBe(true)
		expect(getRuntimeModuleAdapter(ctx).normalizeId('/tmp/a.ts')).toBe('/tmp/a.ts')
		expect(getHmrRuntimeHandles(ctx)?.bundler?.watchTinypoolWorker).toBeTypeOf('function')
		expect(getHmrRuntimeHandles(ctx)?.extensions?.bindUiSource).toBeTypeOf('function')

		await res.hmr.start()
		await res.hmr.close()
		await runtime.dispose()
	})

	it('rejects double attach on the same Context', async () => {
		await using fixture = await createFixture({
			'packages/a/src/index.ts': 'export const entry = "a"\n',
		})
		vi.stubEnv('PLUXEL_HMR_PORT', '0')

		const snapshot: LoaderHmrWorkspaceSnapshot = {
			activeProfile: 'dev',
			roots: ['packages/a'],
			enabled: ['pluxel-plugin-a'],
			builtinPackages: [],
			enabledEntries: ['packages/a/src/index.ts'],
			includedEntries: [],
			watchRoots: ['packages/a'],
			includeGlobs: [],
			excludeGlobs: [],
		}

		const runtime = createRuntimeContext({
			configService: { mode: 'memory' },
			pluginData: { enabled: false },
			packageService: { state: { enabled: false } },
		})
		const ctx = runtime.ctx
		await installLoaderHmr(ctx, {
			cwd: fixture.path,
			snapshot,
			warmup: false,
			printUrls: false,
		})

		await expect(
			installLoaderHmr(ctx, {
				cwd: fixture.path,
				snapshot,
				warmup: false,
				printUrls: false,
			}),
		).rejects.toThrow(/already has loader HMR installed/i)

		await runtime.dispose()
	})
})
