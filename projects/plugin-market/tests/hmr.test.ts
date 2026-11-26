import { cp, mkdir, mkdtempDisposable, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import { expect, it, vi } from 'vitest'

it('serves the market UI and replaces the active plugin on the same workerd Host', async () => {
	const root = resolve(import.meta.dirname, '..')
	const temporary = resolve(root, '../../.tmp')
	await mkdir(temporary, { recursive: true })
	await using fixture = await mkdtempDisposable(join(temporary, 'market-hmr-'))
	for (const name of [
		'src',
		'web',
		'wrangler.jsonc',
		'package.json',
		'tsconfig.json',
		'vite.dev.ts',
	])
		await cp(join(root, name), join(fixture.path, name), { recursive: true })
	await symlink(join(root, 'node_modules'), join(fixture.path, 'node_modules'), 'dir')
	// Read lifecycle counts through the same isolate that serves the HTTP requests.
	await writeFile(
		join(fixture.path, 'src/test-counts.ts'),
		'export const counts = { deployments: 0, plugins: 0 }',
	)
	for (const [file, declaration, observe] of [
		['deployment.ts', "constructor(env: ApplicationEnvironment['env']) {", 'counts.deployments++'],
		['market-plugin.ts', 'protected override init() {', 'counts.plugins++'],
		[
			'application.ts',
			"name: 'Market deployment',",
			"prepare({ effects }) { effects.defer(() => import.meta.hot?.send('market-test:closed')) },",
		],
		[
			'worker.ts',
			'fetch(request, env, ctx) {',
			"if (new URL(request.url).pathname === '/v1/test-counts') return Response.json(counts)",
		],
	] as const) {
		const path = join(fixture.path, 'src', file)
		const source = await readFile(path, 'utf8')
		expect(source).toContain(declaration)
		await writeFile(
			path,
			"import { counts } from './test-counts'\n" +
				source.replace(declaration, declaration + '\n' + observe),
		)
	}

	const server = await createServer({
		configFile: join(fixture.path, 'vite.dev.ts'),
		cacheDir: join(fixture.path, '.vite'),
		mode: 'development',
		server: { host: '127.0.0.1', port: 0, strictPort: true },
	})
	try {
		await server.listen()
		const address = server.httpServer!.address()
		if (!address || typeof address === 'string') throw new Error('Missing Vite listener')
		const origin = `http://127.0.0.1:${address.port}`
		const readCounts = async () => {
			const response = await fetch(origin + '/v1/test-counts')
			return response.json()
		}
		const readVersion = async () => {
			const response = await fetch(origin + '/v1')
			expect(response.status).toBe(200)
			return ((await response.json()) as { protocolVersion: number }).protocolVersion
		}
		const page = await fetch(origin, { headers: { Accept: 'text/html' } })
		expect(await page.text()).toContain('Pluxel Plugin Market')
		expect(await Promise.all([readVersion(), readVersion()])).toEqual([1, 1])
		expect(await readCounts()).toEqual({ deployments: 1, plugins: 1 })
		const file = join(fixture.path, 'src/catalog/http.ts')
		const source = await readFile(file, 'utf8')
		const edit = (version: number) =>
			writeFile(file, source.replace('protocolVersion: 1', `protocolVersion: ${version}`))
		await edit(2)
		await vi.waitFor(async () => expect(await readVersion()).toBe(2), { timeout: 10_000 })
		expect(await readCounts()).toEqual({ deployments: 1, plugins: 2 })

		let rejected = false
		server.environments.cloudflare!.hot.on('market-test:broken', () => {
			rejected = true
		})
		await writeFile(
			file,
			source +
				"\nimport.meta.hot?.send('market-test:broken')\nthrow new Error('market fixture failed evaluation')\n",
		)
		await vi.waitFor(() => expect(rejected).toBe(true), { timeout: 10_000 })
		expect(await readVersion()).toBe(2)
		expect(await readCounts()).toEqual({ deployments: 1, plugins: 2 })
		await edit(3)
		await vi.waitFor(async () => expect(await readVersion()).toBe(3), { timeout: 10_000 })
		expect(await readCounts()).toEqual({ deployments: 1, plugins: 3 })

		let closed = false
		server.environments.cloudflare!.hot.on('market-test:closed', () => {
			closed = true
		})
		const app = join(fixture.path, 'src/application.ts')
		const appSource = await readFile(app, 'utf8')
		await writeFile(app, appSource.replace("name: 'Plugin Market'", "name: 'Updated Market'"))
		await vi.waitFor(() => expect(closed).toBe(true), { timeout: 10_000 })
		await vi.waitFor(
			async () => {
				expect(await readVersion()).toBe(3)
				expect(await readCounts()).toEqual({ deployments: 2, plugins: 4 })
			},
			{ timeout: 10_000 },
		)
	} finally {
		await server.close()
	}
}, 45_000)
