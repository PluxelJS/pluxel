import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHost } from '@pluxel/host'
import { elysia, createElysiaHandler } from '@pluxel/services/elysia'
import { workbenchService } from '../src/service'
import { workbenchHttp } from '../src/http'
import { workbenchSourceShell } from '../src/dev'
import { describe, expect, it, vi } from 'vitest'
import { build, createServer } from 'vite'
import { fileURLToPath } from 'node:url'
import { createDiskFixture } from '@pluxel/test/fixtures'

import { renderRuntimeUiHtml } from '../src/shell/html'

const assets = {
	js: '/src/client.tsx',
	css: [],
	preload: [],
}

describe('Workbench UI HTML rendering', () => {
	it('builds lazy chunk preloads under the packaged shell asset mount', async () => {
		await using fixture = await createDiskFixture({
			'entry.js': 'globalThis.load = () => import("./lazy.js")',
			'lazy.js': 'import "./lazy.css"; import { value } from "./shared.js"; export default value',
			'lazy.css': 'body { color: red }',
			'shared.js': 'export const value = 42',
		})
		const output = await build({
			configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
			logLevel: 'silent',
			build: {
				write: false,
				minify: false,
				manifest: false,
				sourcemap: false,
				rolldownOptions: { input: fixture.getPath('entry.js') },
			},
		})
		const bundles = Array.isArray(output) ? output : [output]
		const code = bundles
			.flatMap((bundle) => ('output' in bundle ? bundle.output : []))
			.filter((item) => item.type === 'chunk')
			.map((item) => item.code)
			.join('\n')
		expect(code).toContain('/__pluxel/workbench/')
	})

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

	it('attaches a source Shell to the same Vite graph without built assets or implicit Management', async () => {
		await using fixture = await createDiskFixture({
			'source.js': 'export const version = "before"',
		})
		const plugin = workbenchSourceShell({ entry: './source.js' })
		const server = await createServer({
			configFile: false,
			root: fixture.getPath(),
			base: '/development/',
			appType: 'custom',
			logLevel: 'silent',
			server: { middlewareMode: true, hmr: false },
			plugins: [plugin],
		})
		const host = await createHost({
			plugins: [],
			services: [
				elysia(),
				workbenchService(),
				workbenchHttp({ uiBasePath: '/admin', publicDir: fixture.getPath('missing-built-ui') }),
			],
		})
		try {
			const detach = await plugin.api!.pluxelHost.attach({
				host,
				server,
				semantics: {} as never,
				catalog: { modules: [], definitions: [] },
			})
			if (typeof detach !== 'function') throw new Error('source Shell did not return its cleanup')
			const handle = createElysiaHandler(host)
			const page = await handle(
				new Request('http://local.dev/admin', { headers: { accept: 'text/html' } }),
			)
			const html = await page.text()
			const output = await server.transformIndexHtml('/admin', html)
			const url = `/@fs${fixture.getPath('source.js')}`
			expect(output).toContain(`/development${url}`)
			expect(output).toContain('/@vite/client')
			expect(output).not.toContain('/__pluxel/workbench/assets/')
			expect((await server.transformRequest(url))!.code).toContain('before')
			await writeFile(fixture.getPath('source.js'), 'export const version = "after"')
			await vi.waitFor(async () =>
				expect((await server.transformRequest(url))!.code).toContain('after'),
			)
			const management = await handle(new Request('http://local.dev/__pluxel/runtime/session'))
			expect(management.status).toBe(404)
			await detach()
			await detach()
			await expect(
				handle(new Request('http://local.dev/admin', { headers: { accept: 'text/html' } })),
			).rejects.toThrow('Workbench UI manifest')
		} finally {
			await server.close()
			await host.close()
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
		const escaped = renderRuntimeUiHtml({
			js: '/src/shell&copy;.ts',
			css: ['/assets/theme?name="day"&mode=light'],
			preload: ['/assets/vendor<main>.js'],
		})
		expect(escaped).toContain('src="/src/shell&amp;copy;.ts"')
		expect(escaped).toContain('href="/assets/theme?name=&quot;day&quot;&amp;mode=light"')
		expect(escaped).toContain('href="/assets/vendor&lt;main&gt;.js"')
	})
})

describe('packaged shell HTTP boundary', () => {
	it('serves navigation and immutable assets while allowing business/API fallthrough', async () => {
		const { createWorkbenchShellHandler } = await import('../src/shell')
		const publicDir = await mkdtemp(join(tmpdir(), 'workbench-shell-'))
		try {
			await mkdir(join(publicDir, '.vite'))
			await mkdir(join(publicDir, 'assets'))
			await writeFile(
				join(publicDir, '.vite/manifest.json'),
				JSON.stringify({ 'shell/src/client.tsx': { isEntry: true, file: 'assets/client.js' } }),
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

describe('packaged Shell manifest contract', () => {
	const entry = 'shell/src/client.tsx'
	async function fixture(manifest: Record<string, unknown>, files: Record<string, string> = {}) {
		const publicDir = await mkdtemp(join(tmpdir(), 'workbench-manifest-'))
		await mkdir(join(publicDir, '.vite'))
		await mkdir(join(publicDir, 'assets'))
		await writeFile(join(publicDir, '.vite/manifest.json'), JSON.stringify(manifest))
		for (const [name, body] of Object.entries(files)) await writeFile(join(publicDir, name), body)
		return publicDir
	}

	it('allows other entries while loading only the declared Shell entry and checking lazy files', async () => {
		const publicDir = await fixture(
			{
				other: { isEntry: true, file: 'assets/other.js' },
				[entry]: {
					isEntry: true,
					file: 'assets/client.js',
					imports: ['shared'],
					dynamicImports: ['lazy'],
				},
				shared: { file: 'assets/shared.js', imports: [entry], css: ['assets/shared.css'] },
				lazy: { file: 'assets/lazy.js', css: ['assets/lazy.css'] },
			},
			{
				'assets/client.js': '',
				'assets/shared.js': '',
				'assets/shared.css': '',
				'assets/lazy.js': '',
				'assets/lazy.css': '',
			},
		)
		try {
			const { resolveBuiltAssets } = await import('../src/shell/assets')
			const builtAssets = await resolveBuiltAssets(publicDir)
			expect(builtAssets.js).toBe('/__pluxel/workbench/assets/client.js')
			expect(builtAssets.preload).toEqual(['/__pluxel/workbench/assets/shared.js'])
			expect(builtAssets.css).toEqual(['/__pluxel/workbench/assets/shared.css'])
		} finally {
			await rm(publicDir, { recursive: true, force: true })
		}
	})

	it('rejects missing entry, missing referenced chunk, missing lazy file and incorrect asset base', async () => {
		const { resolveBuiltAssets } = await import('../src/shell/assets')
		const cases = [
			[{ other: { isEntry: true, file: 'assets/other.js' } }, 'expected isEntry entry'],
			[
				{ [entry]: { isEntry: true, file: 'assets/client.js', imports: ['missing'] } },
				'missing or invalid chunk',
			],
			[
				{
					[entry]: { isEntry: true, file: 'assets/client.js', dynamicImports: ['lazy'] },
					lazy: { file: 'assets/lazy.js' },
				},
				'assets/lazy.js',
			],
			[{ [entry]: { isEntry: true, file: '/assets/client.js' } }, 'relative path under assets/'],
		] as const
		for (const [manifest, message] of cases) {
			const publicDir = await fixture(manifest, { 'assets/client.js': '' })
			try {
				await expect(resolveBuiltAssets(publicDir)).rejects.toThrow(message)
			} finally {
				await rm(publicDir, { recursive: true, force: true })
			}
		}
	})

	it('reports the selected invalid manifest and IO failures instead of serving an alternative', async () => {
		const publicDir = await fixture(
			{ [entry]: { isEntry: true, file: 'assets/client.js' } },
			{ 'assets/client.js': '' },
		)
		try {
			const { resolveBuiltAssets } = await import('../src/shell/assets')
			await writeFile(join(publicDir, '.vite/manifest.json'), '{invalid')
			await expect(resolveBuiltAssets(publicDir)).rejects.toThrow(
				join(publicDir, '.vite/manifest.json'),
			)
			await writeFile(
				join(publicDir, '.vite/manifest.json'),
				JSON.stringify({ [entry]: { isEntry: true, file: 'assets/client.js' } }),
			)
			await symlink('loop', join(publicDir, 'assets/loop'))
			const { createWorkbenchShellHandler } = await import('../src/shell')
			const shell = await createWorkbenchShellHandler({ publicDir })
			const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
			try {
				const response = await shell(new Request('http://host.test/__pluxel/workbench/assets/loop'))
				expect(response?.status).toBe(500)
				expect(logged.mock.calls[0]?.[0]).toEqual(
					expect.objectContaining({
						message: expect.stringContaining('Cannot stat Workbench UI asset'),
					}),
				)
				await writeFile(join(publicDir, 'assets/private.js'), 'secret')
				await chmod(join(publicDir, 'assets/private.js'), 0)
				const unreadable = await shell(
					new Request('http://host.test/__pluxel/workbench/assets/private.js'),
				)
				expect(unreadable?.status).toBe(500)
				expect(logged.mock.calls[1]?.[0]).toEqual(
					expect.objectContaining({
						message: expect.stringContaining('Cannot open Workbench UI asset'),
					}),
				)
			} finally {
				logged.mockRestore()
			}
		} finally {
			await rm(publicDir, { recursive: true, force: true })
		}
	})
})
