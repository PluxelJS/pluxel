import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { execFile, fork } from 'node:child_process'
import { promisify } from 'node:util'
import type { PluginNodeAddress } from '@pluxel/core'
import { PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadPnpmEngine } from '../src/pnpm-engine.ts'
import { ManagedPackageStore } from '../src/store.ts'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('@pnpm/napi adapter', () => {
	it('loads the native engine behind the narrow store adapter', async () => {
		const engine = await loadPnpmEngine()
		expect(engine.engineVersion()).toMatch(/^12\./)
		expect(engine.parseBareSpecifier('@scope/plugin@^1.0.0')).toMatchObject({
			name: '@scope/plugin',
			bareSpecifier: '^1.0.0',
		})
	})
})

describe.runIf(process.env.PLUXEL_PNPM_NATIVE_INTEGRATION === '1')(
	'native registry integration',
	() => {
		it('installs, publishes, and removes a real registry package', async () => {
			const rootDir = await mkdtemp(resolve(tmpdir(), 'pluxel-pnpm-native-'))
			roots.push(rootDir)
			const store = new ManagedPackageStore(await loadPnpmEngine(), {
				rootDir,
				ignoreScripts: true,
				allowBuilds: [],
				minimumReleaseAgeMinutes: 0,
			})
			await store.initialize()

			const installed = await store.install(['is-number@7.0.0'])
			expect(installed).toEqual({ ok: true, succeeded: ['is-number'], failed: [] })
			const snapshot = await store.snapshot()
			expect(snapshot.packages).toEqual([
				expect.objectContaining({
					name: 'is-number',
					installedVersion: '7.0.0',
					entryFile: expect.stringMatching(/\.mjs$/),
				}),
			])
			expect(await readdir(snapshot.entriesDir)).toHaveLength(1)

			const removed = await store.remove(['is-number'])
			expect(removed).toEqual({ ok: true, succeeded: ['is-number'], failed: [] })
			expect(await readdir(snapshot.entriesDir)).toEqual([])
		}, 60_000)
	},
)

it.runIf(process.env.PLUXEL_PNPM_NATIVE_INTEGRATION === '1')(
	'publishes real native installs into a production Host and withdraws without replacing survivors',
	async () => {
		const root = await mkdtemp(resolve(tmpdir(), 'pluxel-pnpm-host-'))
		roots.push(root)
		const archives = new Map<string, Buffer>()
		const address = (name: string): PluginNodeAddress => ({
			definition: { entry: { kind: 'package-root', packageName: name }, exportName: 'Dynamic' },
			variant: 'default',
		})
		const names = ['@fixture/managed-first', '@fixture/managed-retained']
		for (const name of names) {
			const directory = resolve(root, name.split('/')[1]!)
			await mkdir(resolve(directory, 'package'), { recursive: true })
			await writeFile(
				resolve(directory, 'package/package.json'),
				JSON.stringify({ name, version: '1.0.0', type: 'module', exports: './index.mjs' }),
			)
			await writeFile(
				resolve(directory, 'package/index.mjs'),
				`// [pluxel-plugin-semantics] Injected facts
import { BasePlugin, Plugin } from '@pluxel/core'
import { __setPluginDefinition } from '@pluxel/core/toolchain'
class Dynamic extends BasePlugin {}
Plugin()(Dynamic)
__setPluginDefinition(Dynamic, ${JSON.stringify({ abiVersion: PLUGIN_LOWERING_ABI_VERSION, kind: 'plugin', definition: address(name).definition })})
export { Dynamic }
`,
			)
			const archive = resolve(directory, 'package.tgz')
			await promisify(execFile)('tar', ['-czf', archive, '-C', directory, 'package'])
			archives.set(name, await readFile(archive))
		}
		const registry = createServer((request, response) => {
			const path = decodeURIComponent(request.url!.split('?')[0]!).slice(1)
			const name = path.replace(/\/-\/package.tgz$/, '')
			const archive = archives.get(name)
			if (!archive) {
				response.writeHead(404).end()
				return
			}
			if (path.endsWith('/-/package.tgz')) {
				response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(archive)
				return
			}
			response.setHeader('content-type', 'application/json')
			response.end(
				JSON.stringify({
					name,
					'dist-tags': { latest: '1.0.0' },
					versions: {
						'1.0.0': {
							name,
							version: '1.0.0',
							dist: {
								tarball: `http://${request.headers.host}/${name}/-/package.tgz`,
								shasum: createHash('sha1').update(archive).digest('hex'),
							},
						},
					},
				}),
			)
		})
		await new Promise<void>((ready) => registry.listen(0, '127.0.0.1', ready))
		const port = (registry.address() as { port: number }).port
		const rootDir = resolve(root, 'managed')
		await mkdir(rootDir)
		await writeFile(resolve(rootDir, '.npmrc'), `registry=http://127.0.0.1:${port}/\n`)
		const store = new ManagedPackageStore(await loadPnpmEngine(), {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [],
			minimumReleaseAgeMinutes: 0,
		})
		let child: ReturnType<typeof fork> | undefined
		let observed: { running: boolean[]; errors: unknown[] } | undefined
		let diagnostics = ''
		try {
			await store.initialize()
			const script = resolve(root, 'host.mjs')
			const coreManifest = import.meta.resolve('@pluxel/core/package.json')
			const hostManifest = import.meta.resolve('@pluxel/host/package.json')
			await writeFile(
				script,
				`
import { runHostApplication } from ${JSON.stringify(new URL('dist/index.mjs', hostManifest).href)}
import { dynamicSource } from ${JSON.stringify(new URL('dist/dynamic.mjs', hostManifest).href)}
import { requirePluginService } from ${JSON.stringify(new URL('dist/internal.mjs', coreManifest).href)}
const addresses = ${JSON.stringify(names.map(address))}
const host = await runHostApplication(() => ({
  plugins: [], sources: [dynamicSource({ kind: 'directory', path: ${JSON.stringify(store.entriesDir)}, include: ['*.mjs'] })],
  state: { initial: { autoStart: addresses } } }
}), { startup: { root: ${JSON.stringify(root)}, mode: 'production', env: {}, bindings: {} }, frameworkModules: {
  '@pluxel/core': ${JSON.stringify(new URL('dist/index.mjs', coreManifest).href)},
  '@pluxel/core/toolchain': ${JSON.stringify(new URL('dist/toolchain.mjs', coreManifest).href)}
} })
const service = requirePluginService(host.ctx)
const errors = []
host.ctx.logger.error = (message, properties) => errors.push([message, String(properties?.error)])
const report = () => process.send({ running: addresses.map(address => service.isRunning(address)), errors })
const timer = setInterval(report, 25)
process.on('message', async () => { clearInterval(timer); await host.close(); process.disconnect() })
report()
`,
			)
			child = fork(script, { execArgv: [], silent: true })
			child.stderr?.on('data', (chunk) => {
				diagnostics += String(chunk)
			})
			child.on('message', (message) => {
				observed = message as typeof observed
			})
			await expect
				.poll(() => ({ observed, diagnostics }), {
					message: 'fresh Node Host startup; inspect captured diagnostics on failure',
				})
				.toEqual({ observed: { running: [false, false], errors: [] }, diagnostics: '' })
			expect(await store.install(names.map((name) => `${name}@1.0.0`))).toEqual({
				ok: true,
				succeeded: names,
				failed: [],
			})
			await expect.poll(() => observed).toEqual({ running: [true, true], errors: [] })
			const snapshot = await store.snapshot()
			const retained = snapshot.packages.find((pkg) => pkg.name === names[1])!
			const path = resolve(store.entriesDir, retained.entryFile!)
			const beforeRestart = await stat(path)
			await store.initialize()
			expect(await stat(path)).toMatchObject({ ino: beforeRestart.ino })
			expect(await store.remove([names[0]!])).toEqual({
				ok: true,
				succeeded: [names[0]],
				failed: [],
			})
			await expect.poll(() => observed).toEqual({ running: [false, true], errors: [] })
			expect(await stat(path)).toMatchObject({ ino: beforeRestart.ino })
		} finally {
			if (child?.connected) {
				const exited = new Promise<void>((done) => child!.once('exit', () => done()))
				child.send('close')
				await exited
			}
			await store.close()
			registry.closeAllConnections()
			await new Promise<void>((closed, reject) =>
				registry.close((error) => (error ? reject(error) : closed())),
			)
		}
	},
	60_000,
)
