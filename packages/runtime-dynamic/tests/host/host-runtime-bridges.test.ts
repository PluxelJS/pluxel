import type { LoaderHmrWorkspaceSnapshot } from '@pluxel/runtime-dynamic/hmr'
import {
	getHmrRuntimeHandles,
	getRuntimeModuleAdapter,
	hasRuntimeModuleAdapter,
} from '@pluxel/runtime/internal'
import { createFixture } from '@pluxel/test/fixtures'
import { describe, expect, it, vi } from 'vitest'
import { createTestHmrHost } from '../support/test-host'

describe('@pluxel/runtime-dynamic/hmr/host runtime bridges', () => {
	it('installs module adapter + dev handles on the host Context', async () => {
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

		const res = await createTestHmrHost({
			fs: fixture.fs,
			root: fixture.path,
			snapshot,
			warmup: false,
			printUrls: false,
		})

		expect(hasRuntimeModuleAdapter(res.ctx)).toBe(true)
		expect(getRuntimeModuleAdapter(res.ctx).normalizeId('/tmp/a.ts')).toBe('/tmp/a.ts')
		expect(getHmrRuntimeHandles(res.ctx)?.bundler?.watchTinypoolWorker).toBeTypeOf('function')

		const pluginCtx = res.ctx.extend({ name: 'plugin-a' })
		expect(getHmrRuntimeHandles(pluginCtx)?.bundler?.watchTinypoolWorker).toBeTypeOf('function')

		await res.hmr.close()
		await res.ctx.effects.dispose()
	}, 15_000)
})
