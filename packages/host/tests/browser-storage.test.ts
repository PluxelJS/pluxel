import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configSourcePlugin, createPluginSemanticsPlugin } from '@pluxel/rolldown/plugins'
import { chromium } from 'playwright-core'
import { build, type Plugin } from 'vite-plus'
import { expect, it } from 'vitest'

it('restores built-in config, native Stores and owner files in a browser and a Web Worker', async () => {
	const hostRoot = fileURLToPath(new URL('../', import.meta.url))
	await mkdir(join(hostRoot, '.tmp'), { recursive: true })
	const root = await mkdtemp(join(hostRoot, '.tmp/browser-storage-'))
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		await symlink(hostRoot, join(root, 'node_modules/@pluxel/host'), 'dir')
		await writeFile(
			join(root, 'package.json'),
			'{"name":"browser-storage-fixture","private":true,"type":"module"}',
		)
		await writeFile(join(root, 'entry.ts'), fixture)
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
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 60_000)

const fixture = `
import { BasePlugin, Plugin } from '@pluxel/core'
import { requireTinyBaseHost } from '@pluxel/core/internal'
import { writeFileAtomic } from '@pluxel/core/fs'
import { IndexedDB } from '@pluxel/core/fs/browser'
import { createHost } from '@pluxel/host/browser'
import * as v from 'valibot'
let running
@Plugin()
class Owner extends BasePlugin {
 readonly config = this.configs.use(v.object({ label: v.optional(v.pipe(v.string(), v.trim()), 'initial') }))
 async init() {
  this.store = await this.ctx.tinybase.open()
  this.files = await this.ctx.fs()
  running = this
 }
}
export async function run() {
 const storeName = 'pluxel-built-in-' + crypto.randomUUID()
 const owner = Owner.nodeAddress()
 const options = { plugins:[Owner], runtime:{ zenfs:{ mounts: { '/': { backend:IndexedDB, storeName } }, durableMounts: ['/'] }, documents:{state:false} } }
 let host
 try {
  host = await createHost(options)
  const patched = await host.config.patch(owner, {set:{label:' persisted '}})
  if (!patched.ok) throw new Error(patched.message)
  await host.startNode(owner)
  running.store.setValue('value',42)
  await running.ctx.tinybase.flush()
  await writeFileAtomic(running.files,'owner.txt','OWNER-FILE')
  const staleStore = running.store, staleFiles = running.files
  await host.close()
  let closed
  try { await staleFiles.readFile('owner.txt') } catch (error) { closed = error.code }
  staleStore.setValue('stale',true)
  host = await createHost(options)
  const config = await host.config.get(owner)
  if (!config.ok) throw new Error(config.message)
  const beforeStart = {stores:requireTinyBaseHost(host.ctx).status().filter(item=>item.identity.kind==='plugin').length,label:config.config.label,application:config.application}
  await host.startNode(owner)
  const reopened = {label:running.config.label,value:running.store.getValue('value'),file:await running.files.readFile('owner.txt','utf8')}
  return {beforeStart,reopened,closed,stalePersisted:running.store.hasValue('stale'),execution:typeof document === 'undefined'?'worker':'window',nodeGlobals:typeof process!=='undefined'||typeof Buffer!=='undefined'||typeof require!=='undefined'}
 } finally {
  await host?.close()
  await new Promise((resolve,reject)=>{const request=indexedDB.deleteDatabase(storeName);request.onsuccess=resolve;request.onerror=()=>reject(request.error);request.onblocked=()=>reject(new Error('Host leaked an IDB connection'))})
 }
}
`
