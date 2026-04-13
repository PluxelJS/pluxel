import type { HmrWorkspaceSnapshot } from '@pluxel/hmr/snapshot'
import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'
import { SuperJSON } from 'superjson'
import { HMR_INTERNAL_API_BASE, HMR_TRANSPORT_PATHS } from '@pluxel/runtime/web/paths'
import { Context } from '@pluxel/runtime'
import { createCompiledExtensionModule } from '@pluxel/runtime/internal'
import { createTestHmrHost } from '../support/test-host'

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

	it('renders dev UI with a Vite-accessible source entry and rejects stale /dist/public asset requests', async () => {
		const ctx = new Context({
			configService: { mode: 'memory' },
			http: {
				uiAssets: 'dev-server',
				controlPlane: { web: false, rpc: false, sse: false, auth: 'none' },
			},
		})

		const htmlRes = await ctx.http.fetch(
			new Request('http://local/', {
				headers: { accept: 'text/html' },
			}),
		)
		expect(htmlRes.status).toBe(200)
		const html = await htmlRes.text()
		expect(html).toContain('<script type="module" src="/@fs/')
		expect(html).not.toContain('/dist/public/assets/')

		const staleAsset = await ctx.http.fetch(
			new Request('http://local/dist/public/assets/mf-runtime-stale.js'),
		)
		expect(staleAsset.status).toBe(404)
		expect(await staleAsset.text()).toContain('Not Found')
		await ctx.effects.dispose()
	})

	it('refreshes static HTML asset hashes after manifest changes without restarting the host', async () => {
		await using fixture = await createFixture({
			'dist/public/.vite/manifest.json': JSON.stringify(
				{
					'src/client.tsx': {
						file: 'assets/client-old.js',
						isEntry: true,
						css: ['assets/client-old.css'],
					},
				},
				null,
				2,
			),
			'dist/public/assets/client-old.js': 'console.log("old")\n',
			'dist/public/assets/client-old.css': 'body { color: red; }\n',
			'dist/public/assets/client-new.js': 'console.log("new")\n',
			'dist/public/assets/client-new.css': 'body { color: blue; }\n',
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

		const firstHtml = await ctx.http
			.fetch(new Request('http://local/', { headers: { accept: 'text/html' } }))
			.then((res) => res.text())
		expect(firstHtml).toContain('/dist/public/assets/client-old.js')
		expect(firstHtml).toContain('/dist/public/assets/client-old.css')

		await writeFile(
			resolve(publicDir, '.vite/manifest.json'),
			JSON.stringify(
				{
					'src/client.tsx': {
						file: 'assets/client-new.js',
						isEntry: true,
						css: ['assets/client-new.css'],
					},
				},
				null,
				2,
			),
			'utf8',
		)

		const secondHtml = await ctx.http
			.fetch(new Request('http://local/', { headers: { accept: 'text/html' } }))
			.then((res) => res.text())
		expect(secondHtml).toContain('/dist/public/assets/client-new.js')
		expect(secondHtml).toContain('/dist/public/assets/client-new.css')
		expect(secondHtml).not.toContain('/dist/public/assets/client-old.js')
		await ctx.effects.dispose()
	})

	it('exposes the internal GraphQL transport used by the UI', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - packages/*', ''].join('\n'),
			// HMR may persist runtime config under `data/`; pre-create so fixture cleanup is stable.
			'data/runtime/config.dev.json': `${SuperJSON.stringify({
				enabled: new Set<string>(),
				plugins: {},
				extra: {},
			})}\n`,
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
		const host = await createTestHmrHost({
			fs: fixture.fs,
			root: fixture.path,
			snapshot,
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
	}, 15_000)

	it('serves extension artifact manifests and files through the internal artifact route', async () => {
		await using fixture = await createFixture({
			artifacts: {
				'mf-manifest.json': JSON.stringify({
					metaData: {
						publicPath: '/stale/',
					},
				}),
				'remoteEntry.js': 'export const ok = 1\n',
			},
		})

		const ctx = new Context({
			configService: { mode: 'memory' },
			http: {
				uiAssets: 'disabled',
				controlPlane: { web: true, rpc: false, sse: false, auth: 'none' },
			},
			extensionService: {
				enabled: true,
			},
		})

		await ctx.ext.ui.commitCompiledModule(
			createCompiledExtensionModule({
				pluginName: 'DemoPlugin',
				sourceHash: 'demo-hash',
				compiledAt: 123,
			}),
			{ artifactRoot: resolve(fixture.path, 'artifacts') },
		)

		const manifestUrl = ctx.ext.ui.getCompiledModule('DemoPlugin')?.manifestUrl
		expect(manifestUrl).toBeTruthy()

		const manifestRes = await ctx.http.fetch(new Request(`http://local${manifestUrl}`))
		expect(manifestRes.status).toBe(200)
		expect(manifestRes.headers.get('content-type')).toContain('application/json')
		const manifest = (await manifestRes.json()) as {
			metaData?: { publicPath?: string }
		}
		expect(manifest.metaData?.publicPath).toBe(
			`${HMR_INTERNAL_API_BASE}/extensions/artifacts/DemoPlugin/demo-hash/`,
		)

		const assetRes = await ctx.http.fetch(
			new Request(`http://local${manifest.metaData?.publicPath}remoteEntry.js`),
		)
		expect(assetRes.status).toBe(200)
		expect(assetRes.headers.get('content-type')).toContain('application/javascript')
		expect(await assetRes.text()).toContain('export const ok = 1')
		await ctx.effects.dispose()
	})
})
