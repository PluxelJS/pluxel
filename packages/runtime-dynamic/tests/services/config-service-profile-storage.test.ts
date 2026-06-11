import type { LoaderHmrWorkspaceSnapshot } from '@pluxel/runtime-dynamic/hmr'
import { createFixture } from '@pluxel/test/fixtures'
import { dirname, resolve } from 'pathe'
import { SuperJSON } from 'superjson'
import { describe, expect, it } from 'vitest'
import { createTestHmrHost } from '../support/test-host'

describe('HMR ConfigService profile storage', () => {
	it('writes a per-profile config file (and can seed from the base file)', async () => {
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
						'.': { '@pluxel/runtime-dynamic': './src/index.ts', default: './dist/index.mjs' },
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
				storage: {},
				snapshot,
			})
			ctx = host.ctx

			// Seed the base config file (shared name). The HMR ConfigService should read it as a fallback
			// and then write the per-profile file on first load.
			const base = resolve(fixture.path, '.pluxel/loader-hmr/config.json')
			await fixture.fsp.mkdir(dirname(base), { recursive: true })
			await fixture.fsp.writeFile(
				base,
				SuperJSON.stringify({
					enabled: new Set(['pluxel-plugin-a']),
					plugins: {},
					extra: {},
				}),
			)

			await host.ctx.root.configService.ready

			const perProfile = resolve(fixture.path, '.pluxel/loader-hmr/config.dev.json')
			expect(fixture.fs.existsSync(base)).toBe(true)
			expect(fixture.fs.existsSync(perProfile)).toBe(true)
		} finally {
			if (ctx) await ctx.effects.dispose()
		}
	}, 15_000)

	it('supports `{profile}` in storage.configFile (directory placement)', async () => {
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
				storage: { configFile: '.pluxel/runtime/{profile}/config.json', seedConfig: false },
				snapshot,
			})
			ctx = host.ctx

			await host.ctx.root.configService.ready

			const perProfile = resolve(fixture.path, '.pluxel/runtime/dev/config.json')
			expect(fixture.fs.existsSync(perProfile)).toBe(true)
		} finally {
			if (ctx) await ctx.effects.dispose()
		}
	})
})
