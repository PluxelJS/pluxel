import { createHmrHost } from '@pluxel/hmr/host'
import type { HmrWorkspaceSnapshot } from '@pluxel/hmr/snapshot'
import { createFixture } from 'fs-fixture'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'
import { HMR_INTERNAL_API_BASE, HMR_TRANSPORT_PATHS } from '@pluxel/runtime/web/paths'
import { Context } from '@pluxel/runtime'

describe('HMR UI smoke', () => {
	it('serves built UI assets from /dist/public', async () => {
		await using fixture = await createFixture({
			'dist/public/assets/hello.js': 'console.log("hello")\n',
		})

		const publicDir = resolve(fixture.path, 'dist/public')
		const ctx = new Context({
			configService: { mode: 'memory' },
			http: {
				uiAssets: 'static-built',
				uiPublicDir: publicDir,
				controlPlane: { web: false, rpc: false, sse: false, auth: 'none' },
			},
		})

		const res1 = await ctx.http.fetch(new Request('http://local/dist/public/assets/hello.js'))
		expect(res1.status).toBe(200)
		expect(res1.headers.get('content-type')).toContain('application/javascript')

		// Regression: missing assets must not fall through to an HTML SPA fallback
		// (which triggers strict-MIME errors in browsers).
		const res3 = await ctx.http.fetch(new Request('http://local/dist/public/assets/missing.css'))
		expect(res3.status).toBe(404)
		expect(await res3.text()).toContain('Not Found')
		await ctx.effects.dispose()
	})

	it('exposes the internal GraphQL transport used by the UI', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - packages/*', ''].join('\n'),
			// HMR may persist runtime config under `data/`; pre-create so fixture cleanup is stable.
			'data/runtime/config.dev.json': '{}\n',
			'packages/a/package.json': JSON.stringify(
				{
					name: 'pluxel-plugin-a',
					version: '0.0.0',
					type: 'module',
					exports: { '.': { '@pluxel/runtime': './src/index.ts', default: './dist/index.mjs' } },
				},
				null,
				2,
			),
			'packages/a/src/index.ts': 'export const plugins = []\n',
			'packages/a/dist/index.mjs': 'export const plugins = []\n',
		})

		const prevCwd = process.cwd()
		try {
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
			const host = await createHmrHost({
				root: fixture.path,
				logging: false,
				workspaceSnapshot: snapshot,
			})

			const res = await host.ctx.http.fetch(
				new Request(`http://local${HMR_INTERNAL_API_BASE}${HMR_TRANSPORT_PATHS.graphql}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ query: '{ _empty }' }),
				}),
			)

			expect(res.status).toBe(200)
			const json = (await res.json()) as { data?: { _empty?: string } }
			expect(json.data?._empty).toBe('ok')
			await host.ctx.effects.dispose()
		} finally {
			process.chdir(prevCwd)
		}
	}, 15_000)
})
