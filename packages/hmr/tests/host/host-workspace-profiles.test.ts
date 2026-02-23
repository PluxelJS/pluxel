import { describe, expect, it } from 'vitest'
import { createFixture } from 'fs-fixture'
import { resolve } from 'pathe'
import { createHmrHost } from '@pluxel/hmr/host'

describe('@pluxel/hmr/host workspace profiles', () => {
	it('refuses to start when pluxel.hmr.jsonc is missing', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - packages/*', ''].join('\n'),
			'packages/a/package.json': JSON.stringify({ name: 'a', version: '0.0.0' }),
		})

		const prevCwd = process.cwd()
		try {
			let err: unknown
			try {
				await createHmrHost({ root: fixture.path, logging: false })
			} catch (e) {
				err = e
			}

			expect(err).toBeInstanceOf(Error)
			expect((err as Error).message).toContain('Missing config file')
			expect((err as Error).message).toContain('pluxel.hmr.jsonc')
		} finally {
			process.chdir(prevCwd)
		}
	})

	it('uses pluxel.hmr.jsonc for discovery when entries is not provided', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - packages/*', ''].join('\n'),
			'pluxel.hmr.jsonc': [
				'// test fixture',
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
		try {
			const res = await createHmrHost({ root: fixture.path, logging: false })
			expect(res.root).toBe(resolve(fixture.path))
		} finally {
			process.chdir(prevCwd)
		}
	}, 15_000)
})
