import { copyFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { configSourcePlugin, createPluginSemanticsPlugin } from '@pluxel/rolldown/plugins'
import { chromium } from 'playwright-core'
import { build, type Plugin } from 'vite-plus'
import { expect, it } from 'vitest'
import { createWorkspace } from '../support/workspace'

it('restores built-in config, native Stores and owner files in a browser and a Web Worker', async () => {
	await using workspace = await createWorkspace('browser-storage', ['host'])
	const { root } = workspace
	await writeFile(
		join(root, 'package.json'),
		'{"name":"browser-storage-fixture","private":true,"type":"module"}',
	)
	await copyFile(new URL('./storage.fixture.ts', import.meta.url), join(root, 'entry.ts'))
	const modules: string[] = []
	const output = await build({
		configFile: false,
		root,
		logLevel: 'silent',
		oxc: { decorator: { legacy: true } },
		resolve: { conditions: ['@pluxel/source', 'browser', 'module', 'production'] },
		plugins: [
			createPluginSemanticsPlugin({ root }).plugin as unknown as Plugin,
			configSourcePlugin() as unknown as Plugin,
			{
				name: 'observe-browser-storage-closure',
				generateBundle() {
					for (const id of this.getModuleIds()) {
						modules.push(id)
					}
				},
			},
		],
		build: {
			write: false,
			target: 'esnext',
			minify: false,
			lib: { entry: join(root, 'entry.ts'), formats: ['iife'], name: 'BrowserStorage' },
		},
	})
	const chunks = (Array.isArray(output) ? output : [output]).flatMap((result) => {
		if (!('output' in result)) throw new Error('Expected an immediate browser build')
		return result.output.filter((chunk) => chunk.type === 'chunk')
	})
	expect(chunks).toHaveLength(1)
	const chunk = chunks[0]!
	expect(chunk.imports).toEqual([])
	expect(chunk.dynamicImports.filter((id) => id !== chunk.fileName)).toEqual([])
	expect(
		modules.filter((id) =>
			/^(?:node:|__vite-browser-external)|@pluxel\/(?:services|host-vite)/.test(id),
		),
	).toEqual([])
	expect(chunk.code).not.toContain('__vite-browser-external')
	const browser = process.env.PLAYWRIGHT_WS_ENDPOINT
		? await chromium.connect(process.env.PLAYWRIGHT_WS_ENDPOINT, { timeout: 10_000 })
		: await chromium.launch({ headless: true })
	try {
		const context = await browser.newContext()
		try {
			await context.route('https://browser-storage.test/**', (route) =>
				route.fulfill({
					contentType: 'text/html',
					body: '<!doctype html><title>Core storage</title>',
				}),
			)
			const page = await context.newPage()
			const errors: string[] = []
			page.on('pageerror', (error) => errors.push(error.message))
			await page.goto('https://browser-storage.test/')
			await page.addScriptTag({ content: chunk.code })
			const windowResult = await page.evaluate('BrowserStorage.run()')
			const workerResult = await page.evaluate(async (code) => {
				const url = URL.createObjectURL(
					new Blob(
						[
							code,
							`
self.onmessage = async () => {
 try { self.postMessage({ result: await BrowserStorage.run() }) }
 catch (error) { self.postMessage({ error: String(error.stack ?? error) }) }
}`,
						],
						{ type: 'text/javascript' },
					),
				)
				const worker = new Worker(url)
				try {
					return await new Promise((resolve, reject) => {
						worker.onmessage = ({ data }) =>
							data.error ? reject(new Error(data.error)) : resolve(data.result)
						worker.onerror = (error) => reject(new Error(error.message))
						worker.postMessage(null, [])
					})
				} finally {
					worker.terminate()
					URL.revokeObjectURL(url)
				}
			}, chunk.code)
			for (const result of [windowResult, workerResult])
				expect(result).toMatchObject({
					beforeStart: { stores: 0, label: 'persisted', application: 'deferred' },
					reopened: { label: 'persisted', value: 42, file: 'OWNER-FILE' },
					closed: 'EBADF',
					stalePersisted: false,
					nodeGlobals: false,
				})
			expect((windowResult as { execution: string }).execution).toBe('window')
			expect((workerResult as { execution: string }).execution).toBe('worker')
			expect(errors).toEqual([])
		} finally {
			await context.close()
		}
	} finally {
		await browser.close()
	}
}, 60_000)
