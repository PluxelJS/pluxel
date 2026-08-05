import {
	bootPlannedLoaderHmrHost,
	planLoaderHmrHostFromConfig,
	type LoaderHmrWorkspaceSnapshot,
} from '@pluxel/runtime-dynamic/hmr'
import { createFixture } from '@pluxel/test/fixtures'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'
import { createTestHmrHost } from '../support/test-host'

describe('HMR runtime persistence storage', () => {
	it('initializes plugin config from the dynamic host environment', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - packages/*', ''].join('\n'),
			'pluxel.loader.hmr.jsonc': [
				'{',
				'  "version": 1,',
				'  "profile": "dev",',
				'  "defaults": { "roots": "auto" },',
				'  "profiles": { "dev": { "enabled": [] } }',
				'}',
				'',
			].join('\n'),
		})

		const plan = await planLoaderHmrHostFromConfig({
			root: fixture.path,
			fs: fixture.fs,
			chdir: false,
			logging: false,
			configService: { mode: 'memory' },
			runtimeState: { mode: 'memory' },
			env: {
				PLUXEL_CONFIG__ExamplePlugin__config__endpoint: 'https://api.example.test',
			},
		})
		const host = await bootPlannedLoaderHmrHost(plan)
		try {
			expect(host.ctx.configService.getRawConfig('ExamplePlugin')).toEqual({
				config: { endpoint: 'https://api.example.test' },
			})
		} finally {
			await host.stop()
		}
	})

	it('stores config and runtime state under the shared persistence root', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - packages/*', ''].join('\n'),
			'pluxel.loader.hmr.jsonc': [
				'{',
				'  "version": 1,',
				'  "profile": "dev",',
				'  "defaults": { "roots": "auto" },',
				'  "profiles": { "dev": { "enabled": ["pluxel-plugin-a"] } }',
				'}',
				'',
			].join('\n'),
			'packages/a/package.json': JSON.stringify(
				{
					name: 'pluxel-plugin-a',
					version: '0.0.0',
					type: 'module',
					exports: {
						'.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' },
					},
				},
				null,
				2,
			),
			'packages/a/src/index.ts': 'export const entry = "a"\n',
			'packages/a/dist/index.mjs': 'export const entry = "dist"\n',
		})

		let ctx: Awaited<ReturnType<typeof createTestHmrHost>>['ctx'] | undefined
		try {
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
			const host = await createTestHmrHost({
				fs: fixture.fs,
				root: fixture.path,
				snapshot,
			})
			ctx = host.ctx

			await host.ctx.root.configService.ready
			await host.ctx.root.runtimeState.ready

			expect(
				fixture.fs.existsSync(resolve(fixture.path, '.pluxel/persistence/config/config.json')),
			).toBe(true)
			expect(
				fixture.fs.existsSync(
					resolve(fixture.path, '.pluxel/persistence/runtime-state/state.json'),
				),
			).toBe(true)
			expect(
				fixture.fs.existsSync(resolve(fixture.path, '.pluxel/loader-hmr/config.dev.json')),
			).toBe(false)
		} finally {
			if (ctx) await ctx.effects.dispose()
		}
	}, 15_000)

	it('allows changing only the persistence root', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - packages/*', ''].join('\n'),
			'pluxel.loader.hmr.jsonc': [
				'{',
				'  "version": 1,',
				'  "profile": "dev",',
				'  "defaults": { "roots": "auto" },',
				'  "profiles": { "dev": { "enabled": [] } }',
				'}',
				'',
			].join('\n'),
			'packages/a/package.json': JSON.stringify({ name: 'pluxel-plugin-a', version: '0.0.0' }),
		})

		let ctx: Awaited<ReturnType<typeof createTestHmrHost>>['ctx'] | undefined
		try {
			const snapshot: LoaderHmrWorkspaceSnapshot = {
				activeProfile: 'dev',
				roots: [],
				enabled: [],
				builtinPackages: [],
				enabledEntries: [],
				includedEntries: [],
				watchRoots: [],
				includeGlobs: [],
				excludeGlobs: [],
			}
			const host = await createTestHmrHost({
				fs: fixture.fs,
				root: fixture.path,
				storage: { persistenceDir: '.pluxel/runtime-persistence' },
				snapshot,
			})
			ctx = host.ctx

			await host.ctx.root.configService.ready

			expect(
				fixture.fs.existsSync(
					resolve(fixture.path, '.pluxel/runtime-persistence/config/config.json'),
				),
			).toBe(true)
		} finally {
			if (ctx) await ctx.effects.dispose()
		}
	})
})
