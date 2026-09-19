import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'vite'
import { createDiskFixture } from '@pluxel/test/fixtures'

import { renderRuntimeUiHtml } from '../src/shell/html'

const assets = {
	js: '/src/client.tsx',
	css: [],
	preload: [],
}

describe('Workbench UI HTML rendering', () => {
	it('keeps built assets out of Vite pre-transform while preserving HTML and source transforms', async () => {
		await using fixture = await createDiskFixture({ 'source.js': 'export const ready = true' })
		const server = await createServer({
			configFile: false,
			root: fixture.getPath(),
			appType: 'custom',
			logLevel: 'silent',
			server: { middlewareMode: true, hmr: false },
			plugins: [
				{
					name: 'test-shell-html-transform',
					transformIndexHtml: (html) =>
						html.replace('</head>', '<meta name="still-transformed" /></head>'),
				},
			],
		})
		const warmup = vi.spyOn(server, 'warmupRequest')
		const errors = vi.spyOn(server.config.logger, 'error')
		try {
			const built = {
				js: '/__pluxel/workbench/assets/client-built.js',
				css: ['/__pluxel/workbench/assets/client-built.css'],
				preload: ['/__pluxel/workbench/assets/vendor-built.js'],
			}
			const output = await server.transformIndexHtml(
				'/admin',
				renderRuntimeUiHtml(built, { prebuiltAssets: true }),
			)
			expect(output).toContain('/@vite/client')
			expect(output).toContain('name="still-transformed"')
			for (const url of [built.js, ...built.css, ...built.preload]) expect(output).toContain(url)
			expect(output).not.toContain('vite-ignore')
			expect(warmup).not.toHaveBeenCalled()
			await server.transformIndexHtml(
				'/admin',
				renderRuntimeUiHtml({ js: '/source.js', css: [], preload: [] }),
			)
			expect(warmup).toHaveBeenCalledWith('/source.js')
			await Promise.all(warmup.mock.results.map((result) => result.value))
			expect(errors).not.toHaveBeenCalled()
		} finally {
			await server.close()
		}
	})

	it('renders the Workbench UI document without assuming a React refresh endpoint', () => {
		const html = renderRuntimeUiHtml(assets, {
			uiBasePath: '/__pluxel/workbench',
		})

		expect(html).toContain('<script type="module" src="/src/client.tsx"></script>')
		expect(html).toContain(
			'<meta name="pluxel-workbench-ui-base-path" content="/__pluxel/workbench" />',
		)
		expect(html).not.toContain('/@react-refresh')
		expect(html).not.toContain('window.$RefreshReg$')
	})
})

describe('packaged shell HTTP boundary', () => {
	it('serves navigation and immutable assets while allowing business/API fallthrough', async () => {
		const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises')
		const { tmpdir } = await import('node:os')
		const { join } = await import('node:path')
		const { createWorkbenchShellHandler } = await import('../src/shell')
		const publicDir = await mkdtemp(join(tmpdir(), 'workbench-shell-'))
		try {
			await mkdir(join(publicDir, '.vite'))
			await mkdir(join(publicDir, 'assets'))
			await writeFile(
				join(publicDir, '.vite/manifest.json'),
				JSON.stringify({ entry: { isEntry: true, file: 'assets/client.js' } }),
			)
			await writeFile(join(publicDir, 'assets/client.js'), 'console.log("shell")')
			const shell = await createWorkbenchShellHandler({ publicDir, uiBasePath: '/admin' })
			const request = (path: string, init?: RequestInit) =>
				new Request(`http://host.test${path}`, init)
			const navigation = request('/admin/plugins', { headers: { accept: 'text/html' } })
			expect(shell.matchesRequest(navigation)).toBe(true)
			expect(
				shell.matchesRequest(
					request('/admin/plugin-graph/source/Consumer.ts', { headers: { accept: 'text/html' } }),
				),
			).toBe(true)
			expect(
				shell.matchesRequest(
					request('/admin/plugin-graph/source/Consumer.ts', {
						headers: { accept: 'text/css,*/*' },
					}),
				),
			).toBe(false)
			expect(
				shell.matchesRequest(
					request('/admin', { method: 'POST', headers: { accept: 'text/html' } }),
				),
			).toBe(false)
			const html = await shell(navigation)
			expect(await html!.text()).toContain(
				'<script vite-ignore type="module" src="/__pluxel/workbench/assets/client.js">',
			)
			expect(await shell(request('/api', { headers: { accept: 'application/json' } }))).toBeNull()
			expect(shell.matchesRequest(request('/@vite/client'))).toBe(false)
			const asset = await shell(request('/__pluxel/workbench/assets/client.js'))
			expect(await asset!.text()).toBe('console.log("shell")')
			expect(asset!.headers.get('cache-control')).toContain('immutable')
			const cached = await shell(
				request('/__pluxel/workbench/assets/client.js', {
					headers: { 'if-none-match': asset!.headers.get('etag')! },
				}),
			)
			expect(cached!.status).toBe(304)
			const head = await shell(
				request('/admin', { method: 'HEAD', headers: { accept: 'text/html' } }),
			)
			expect(await head!.text()).toBe('')
			const prefixedShell = await createWorkbenchShellHandler({
				publicDir,
				uiBasePath: '/__pluxel/workbench',
			})
			const prefixedPage = await prefixedShell(
				request('/__pluxel/workbench', { headers: { accept: 'text/html' } }),
			)
			expect(prefixedPage!.status).toBe(200)
			const traversal = await shell(request('/__pluxel/workbench/assets/%2e%2e%2f%2e%2e%2fsecret'))
			expect(traversal!.status).toBe(404)
		} finally {
			await rm(publicDir, { recursive: true, force: true })
		}
	})
})
