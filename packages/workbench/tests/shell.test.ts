import { describe, expect, it } from 'vitest'

import { renderRuntimeUiHtml } from '../src/shell/html'

const assets = {
	js: '/src/client.tsx',
	css: [],
	preload: [],
}

describe('Workbench UI HTML rendering', () => {
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
			const html = await shell(navigation)
			expect(await html!.text()).toContain('/__pluxel/workbench/assets/client.js')
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
