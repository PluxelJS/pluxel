import { createDiskFixture as createFixture } from '@pluxel/test/fixtures'
import { withRuntimeContext } from '@pluxel/runtime/test'
import { writeFile } from 'node:fs/promises'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'
import {
	createCompiledWorkbenchArtifact,
	requireRuntimeHttpService,
} from '@pluxel/runtime/internal'
import { requireWorkbench } from '../../../runtime/src/services/workbench'

describe('HMR UI smoke', () => {
	it('renders dev UI with a Vite-accessible source entry and rejects stale /dist/public asset requests', async () => {
		await withRuntimeContext(
			async (ctx) => {
				requireRuntimeHttpService(ctx).reconfigureUiAssets({ uiAssets: 'dev-server' })
				const htmlRes = await requireRuntimeHttpService(ctx).fetch(
					new Request('http://local/', {
						headers: { accept: 'text/html' },
					}),
				)
				expect(htmlRes.status).toBe(200)
				const html = await htmlRes.text()
				expect(html).toContain('<script type="module" src="/@fs/')
				expect(html).not.toContain('/dist/public/assets/')

				const staleAsset = await requireRuntimeHttpService(ctx).fetch(
					new Request('http://local/dist/public/assets/mf-runtime-stale.js'),
				)
				expect(staleAsset.status).toBe(404)
				expect(await staleAsset.text()).toContain('Not Found')
			},
			{
				configService: { mode: 'memory' },
				workbench: { enabled: true },
			},
		)
	})

	it('serves static UI assets and refreshes manifest-backed HTML without restarting the host', async () => {
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
			'dist/public/assets/hello.js': 'console.log("hello")\n',
			'dist/public/assets/client-old.js': 'console.log("old")\n',
			'dist/public/assets/client-old.css': 'body { color: red; }\n',
			'dist/public/assets/client-new.js': 'console.log("new")\n',
			'dist/public/assets/client-new.css': 'body { color: blue; }\n',
		})

		const publicDir = resolve(fixture.path, 'dist/public')
		await withRuntimeContext(
			async (ctx) => {
				requireRuntimeHttpService(ctx).reconfigureUiAssets({
					uiAssets: 'static-built',
					uiPublicDir: publicDir,
				})
				const asset = await requireRuntimeHttpService(ctx).fetch(
					new Request('http://local/dist/public/assets/hello.js'),
				)
				expect(asset.status).toBe(200)
				expect(asset.headers.get('content-type')).toContain('application/javascript')

				// Regression: missing assets must not fall through to an HTML SPA fallback.
				const missingAsset = await requireRuntimeHttpService(ctx).fetch(
					new Request('http://local/dist/public/assets/missing.css'),
				)
				expect(missingAsset.status).toBe(404)
				expect(await missingAsset.text()).toContain('Not Found')

				const firstHtml = await requireRuntimeHttpService(ctx)
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

				const secondHtml = await requireRuntimeHttpService(ctx)
					.fetch(new Request('http://local/', { headers: { accept: 'text/html' } }))
					.then((res) => res.text())
				expect(secondHtml).toContain('/dist/public/assets/client-new.js')
				expect(secondHtml).toContain('/dist/public/assets/client-new.css')
				expect(secondHtml).not.toContain('/dist/public/assets/client-old.js')
			},
			{
				configService: { mode: 'memory' },
				workbench: { enabled: true },
			},
		)
	})

	it('limits Workbench navigation to the configured UI base path', async () => {
		await withRuntimeContext(
			async (ctx) => {
				requireRuntimeHttpService(ctx).reconfigureUiAssets({
					uiAssets: 'dev-server',
					uiBasePath: '/__pluxel/workbench',
				})
				const dashboard = await requireRuntimeHttpService(ctx).fetch(
					new Request('http://local/', { headers: { accept: 'text/html' } }),
				)
				expect(dashboard.status).toBe(404)

				const workbench = await requireRuntimeHttpService(ctx).fetch(
					new Request('http://local/__pluxel/workbench/', {
						headers: { accept: 'text/html' },
					}),
				)
				expect(workbench.status).toBe(200)
				expect(await workbench.text()).toContain(
					'<meta name="pluxel-workbench-ui-base-path" content="/__pluxel/workbench" />',
				)
			},
			{
				configService: { mode: 'memory' },
				workbench: {
					enabled: true,
					uiBasePath: '/__pluxel/workbench',
				},
			},
		)
	})

	it('serves workbench artifact manifests and files through the internal artifact route', async () => {
		const owner = {
			address: {
				definition: {
					entry: { kind: 'source-entry', sourceSpace: 'app', path: 'plugins/demo.ts' },
					exportName: 'DemoPlugin',
				},
				variant: 'default',
			} as const,
			displayName: 'Demo Plugin',
			rootExportName: 'DemoPlugin',
		}
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

		await withRuntimeContext(
			async (ctx) => {
				await requireWorkbench(ctx).artifacts.commitCompiledModule(
					createCompiledWorkbenchArtifact({
						owner,
						sourceHash: 'demo-hash',
						compiledAt: 123,
					}),
					{ artifactRoot: resolve(fixture.path, 'artifacts') },
				)

				const remoteEntryUrl = requireWorkbench(ctx).artifacts.getCompiledModule(
					owner.address,
				)?.remoteEntryUrl
				expect(remoteEntryUrl).toBeTruthy()
				const manifestUrl = remoteEntryUrl?.replace(/remoteEntry\.js$/, 'mf-manifest.json')

				const manifestRes = await requireRuntimeHttpService(ctx).fetch(
					new Request(`http://local${manifestUrl}`),
				)
				expect(manifestRes.status).toBe(200)
				expect(manifestRes.headers.get('content-type')).toContain('application/json')
				const manifest = (await manifestRes.json()) as {
					metaData?: { publicPath?: string }
				}
				expect(manifest.metaData?.publicPath).toBe(remoteEntryUrl?.replace(/remoteEntry\.js$/, ''))

				const assetRes = await requireRuntimeHttpService(ctx).fetch(
					new Request(`http://local${remoteEntryUrl}`),
				)
				expect(assetRes.status).toBe(200)
				expect(assetRes.headers.get('content-type')).toContain('application/javascript')
				expect(await assetRes.text()).toContain('export const ok = 1')
			},
			{
				configService: { mode: 'memory' },
				workbench: { enabled: true },
			},
		)
	})
})
