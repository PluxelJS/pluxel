import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_readConfig } from 'wrangler'
import { marketAssets } from '../dev/assets'
import { projectRoot } from '../dev/session'

describe('native market static assets', () => {
	let runtime: Miniflare
	let directory: string
	let origin: string

	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), 'pluxel-market-assets-'))
		await mkdir(join(directory, 'assets'))
		await mkdir(join(directory, 'v1'))
		await writeFile(join(directory, 'index.html'), '<!doctype html><title>Plugin Market</title>')
		await writeFile(join(directory, 'assets', 'page.js'), 'console.info("market")')
		// Colliding files must never shadow an API or administration route.
		await writeFile(join(directory, 'v1', 'index.html'), 'incorrect API asset')
		await writeFile(join(directory, 'v1', 'unknown.html'), 'incorrect API asset')
		await writeFile(join(directory, 'admin.html'), 'incorrect admin asset')
		const output = await build({
			entryPoints: [resolve(projectRoot, 'src/worker.ts')],
			bundle: true,
			write: false,
			format: 'esm',
			platform: 'browser',
		})
		runtime = new Miniflare({
			port: 0,
			workers: [
				{
					config: {
						name: 'market-assets-test',
						compatibilityDate: '2026-11-03',
						assets: { ...marketAssets, directory },
						manifest: {
							mainModule: 'worker.mjs',
							modules: { 'worker.mjs': { type: 'esm', contents: output.outputFiles[0].text } },
						},
						env: {
							DB: { type: 'd1', id: 'market-assets-test' },
							ADMIN_TOKEN: { type: 'text', value: 'test-admin' },
						},
					},
				},
			],
		})
		const address = await runtime.ready
		origin = address.origin
	})

	afterAll(async () => {
		try {
			await runtime?.dispose()
		} finally {
			if (directory) await rm(directory, { recursive: true, force: true })
		}
	})

	it('keeps the production and sandbox native routing contracts aligned', () => {
		const { assets } = unstable_readConfig({ config: resolve(projectRoot, 'wrangler.jsonc') })
		expect(resolve(projectRoot, assets!.directory!)).toBe(marketAssets.directory)
		expect(assets?.not_found_handling).toBe(marketAssets.notFoundHandling)
		expect(assets?.run_worker_first).toEqual(marketAssets.runWorkerFirst)
	})

	it('serves HTML and JavaScript from the native assets service', async () => {
		const page = await fetch(origin)
		expect(page.status).toBe(200)
		expect(page.headers.get('Content-Type')).toContain('text/html')
		expect(await page.text()).toContain('<title>Plugin Market</title>')
		const script = await fetch(`${origin}/assets/page.js`)
		expect(script.status).toBe(200)
		expect(script.headers.get('Content-Type')).toMatch(/javascript/)
		expect(await script.text()).toBe('console.info("market")')
	})

	it('preserves discovery, API errors and admin authentication despite colliding assets', async () => {
		const discovery = await fetch(`${origin}/v1`)
		expect(discovery.status).toBe(200)
		expect(await discovery.json()).toMatchObject({ protocolVersion: 1 })
		const missing = await fetch(`${origin}/v1/unknown`, { headers: { Accept: 'text/html' } })
		expect(missing.status).toBe(404)
		expect(missing.headers.get('Content-Type')).toContain('application/problem+json')
		expect(await missing.json()).toMatchObject({ code: 'not-found' })
		const admin = await fetch(`${origin}/admin`, { method: 'POST' })
		expect(admin.status).toBe(401)
		expect(await admin.json()).toMatchObject({ code: 'unauthorized' })
		const unknown = await fetch(`${origin}/not-a-page`, { headers: { Accept: 'text/html' } })
		expect(unknown.status).toBe(404)
	})
})
