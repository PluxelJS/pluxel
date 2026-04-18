import { createFixture } from '@pluxel/test/fixtures'
import { describe, expect, it, vi } from 'vitest'

import { attachHmrRuntime } from '@pluxel/hmr'
import type { HmrWorkspaceSnapshot } from '@pluxel/hmr/snapshot'
import {
	getDevRuntimeHandles,
	getRuntimeModuleAdapter,
	hasRuntimeModuleAdapter,
} from '@pluxel/runtime/internal'
import { Context } from '@pluxel/runtime'

describe('@pluxel/hmr attachHmrRuntime', () => {
	it('attaches HMR to an existing Context', async () => {
		await using fixture = await createFixture({
			'packages/a/src/index.ts': 'export const entry = "a"\n',
		})
		vi.stubEnv('PLUXEL_HMR_PORT', '0')

		const snapshot: HmrWorkspaceSnapshot = {
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

		const ctx = new Context({
			configService: { mode: 'memory' },
			pluginData: { enabled: false },
			packageService: { state: { enabled: false } },
			http: {
				uiAssets: 'disabled',
				controlPlane: { web: false, rpc: false, sse: false },
			},
			extensionService: { enabled: false },
		})
		const res = await attachHmrRuntime(ctx, {
			cwd: fixture.path,
			snapshot,
			warmup: false,
			printUrls: false,
		})

		expect(hasRuntimeModuleAdapter(ctx)).toBe(true)
		expect(getRuntimeModuleAdapter(ctx).normalizeId('/tmp/a.ts')).toBe('/tmp/a.ts')
		expect(getDevRuntimeHandles(ctx)?.bundler?.watchTinypoolWorker).toBeTypeOf('function')
		expect(getDevRuntimeHandles(ctx)?.extensions?.bindUiSource).toBeTypeOf('function')

		await res.hmr.start()
		await res.hmr.close()
		await ctx.effects.dispose()
	})

	it('rejects double attach on the same Context', async () => {
		await using fixture = await createFixture({
			'packages/a/src/index.ts': 'export const entry = "a"\n',
		})
		vi.stubEnv('PLUXEL_HMR_PORT', '0')

		const snapshot: HmrWorkspaceSnapshot = {
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

		const ctx = new Context({
			configService: { mode: 'memory' },
			pluginData: { enabled: false },
			packageService: { state: { enabled: false } },
		})
		await attachHmrRuntime(ctx, {
			cwd: fixture.path,
			snapshot,
			warmup: false,
			printUrls: false,
		})

		await expect(
			attachHmrRuntime(ctx, {
				cwd: fixture.path,
				snapshot,
				warmup: false,
				printUrls: false,
			}),
		).rejects.toThrow(/already has HMR attached/i)

		await ctx.effects.dispose()
	})
})
