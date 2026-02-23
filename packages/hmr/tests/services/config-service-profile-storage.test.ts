import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { createFixture } from 'fs-fixture'
import { dirname, resolve } from 'pathe'
import { SuperJSON } from 'superjson'
import { describe, expect, it } from 'vitest'
import { createHmrHost } from '@pluxel/hmr/host'

describe('HMR ConfigService profile storage', () => {
	it('writes a per-profile config file (and can seed from the base file)', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - packages/*', ''].join('\n'),
			'pluxel.hmr.jsonc': [
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

		const prevCwd = process.cwd()
		let ctx: Awaited<ReturnType<typeof createHmrHost>>['ctx'] | undefined
		try {
			const host = await createHmrHost({ root: fixture.path, logging: false, store: {} })
			ctx = host.ctx

			// Seed the base config file (shared name). The HMR ConfigService should read it as a fallback
			// and then write the per-profile file on first load.
			const base = resolve(fixture.path, '.pluxel/hmr/config.json')
			await mkdir(dirname(base), { recursive: true })
			await writeFile(
				base,
				SuperJSON.stringify({
					enabled: new Set(['pluxel-plugin-a']),
					plugins: {},
					extra: {},
				}),
			)

			await host.ctx.root.configService.ready

			const perProfile = resolve(fixture.path, '.pluxel/hmr/config.dev.json')
			expect(existsSync(base)).toBe(true)
			expect(existsSync(perProfile)).toBe(true)
		} finally {
			if (ctx) await ctx.effects.dispose()
			process.chdir(prevCwd)
		}
	}, 15_000)

	it('supports `{profile}` in store.configFile (directory placement)', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - packages/*', ''].join('\n'),
			'pluxel.hmr.jsonc': [
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

		const prevCwd = process.cwd()
		let ctx: Awaited<ReturnType<typeof createHmrHost>>['ctx'] | undefined
		try {
			const host = await createHmrHost({
				root: fixture.path,
				logging: false,
				store: { configFile: '.pluxel/hmr/{profile}/config.json', seedConfig: false },
			})
			ctx = host.ctx

			await host.ctx.root.configService.ready

			const perProfile = resolve(fixture.path, '.pluxel/hmr/dev/config.json')
			expect(existsSync(perProfile)).toBe(true)
		} finally {
			if (ctx) await ctx.effects.dispose()
			process.chdir(prevCwd)
		}
	})
})
