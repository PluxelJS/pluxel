import { createHash } from 'node:crypto'
import { execFile, fork } from 'node:child_process'
import { createServer } from 'node:http'
import {
	access,
	mkdtemp,
	mkdir,
	readFile,
	realpath,
	rm,
	writeFile,
	stat,
	symlink,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createServer as createPortServer } from 'node:net'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { expect, it, onTestFinished } from 'vitest'
import { ManagedPackageStore } from '../src/store.ts'
import { loadPnpmEngine } from '../src/pnpm-engine.ts'

it('pnpm shares immutable dependency slots across private installations', async () => {
	// This is a production consumer: the package's own build is a prerequisite, just like
	// the framework artifacts imported by production-vite.smoke.mjs.
	await access(new URL('../dist/artifacts/node/pluxel-node-artifacts.json', import.meta.url))
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-immutable-install-'))
	const workspace = fileURLToPath(new URL('../../../', import.meta.url))
	let productionChild: ReturnType<typeof fork> | undefined
	let stoppingChild: Promise<void> | undefined
	const stopChild = () =>
		(stoppingChild ??= (async () => {
			const child = productionChild
			if (!child || child.exitCode !== null || child.signalCode !== null) return
			const exited = once(child, 'exit')
			child.kill()
			const force = setTimeout(() => child.kill('SIGKILL'), 5_000)
			force.unref()
			try {
				await exited
			} finally {
				clearTimeout(force)
			}
		})())
	onTestFinished(stopChild)
	const archives = new Map<string, Buffer>()
	const packages = [
		{ name: 'fixture-p', version: '1.0.0', dependencies: {} },
		{ name: 'fixture-p', version: '2.0.0', dependencies: {} },
		{ name: 'fixture-p', version: '3.0.0', dependencies: {} },
		{ name: 'fixture-a', version: '1.0.0', dependencies: { 'fixture-p': '1.0.0' } },
		{ name: 'fixture-a', version: '2.0.0', dependencies: { 'fixture-p': '1.0.0' } },
		{ name: 'fixture-b', version: '1.0.0', dependencies: { 'fixture-p': '1.0.0' } },
		{ name: 'fixture-a', version: '3.0.0', dependencies: { 'fixture-p': '2.0.0' } },
		{ name: 'fixture-b', version: '2.0.0', dependencies: { 'fixture-p': '2.0.0' } },
		{ name: 'fixture-b', version: '3.0.0', dependencies: {} },
		{ name: 'fixture-a', version: '4.0.0', dependencies: { 'fixture-p': '3.0.0' } },
	]
	const registry = createServer((request, response) => {
		const origin = `http://${request.headers.host}`
		const url = new URL(request.url ?? '/', origin)
		const path = decodeURIComponent(url.pathname)
		// This catalog speaks the HTTP contract independently of the reference Worker.
		const checked = /^\/community\/v1\/packages\/(fixture-[ab])\/releases\/([12]\.0\.0)$/.exec(path)
		if (checked) {
			const [, name, version] = checked
			if (url.searchParams.get('registry') !== origin) {
				response.writeHead(404).end()
				return
			}
			response.writeHead(200, { 'content-type': 'application/json' }).end(
				JSON.stringify({
					name,
					version,
					registry: origin,
					integrity: `sha512-${createHash('sha512')
						.update(archives.get(`${name}-${version}`)!)
						.digest('base64')}`,
					checkedAt: Date.now(),
					provenance: { status: 'missing' },
					peerDependencies: {},
					pluginPackages: {},
					readme: null,
					license: null,
				}),
			)
			return
		}
		const archive = archives.get(path.slice('/archive/'.length))
		if (path.startsWith('/archive/') && archive) {
			response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(archive)
			return
		}
		const name = path.slice(1)
		const versions = packages.filter((pkg) => pkg.name === name)
		if (versions.length === 0) {
			response.writeHead(404).end()
			return
		}
		response.setHeader('content-type', 'application/json')
		response.end(
			JSON.stringify({
				name,
				'dist-tags': { latest: versions.at(-1)!.version },
				versions: Object.fromEntries(
					versions.map((pkg) => [
						pkg.version,
						{
							...pkg,
							dist: {
								tarball: `http://${request.headers.host}/archive/${pkg.name}-${pkg.version}`,
								integrity: `sha512-${createHash('sha512')
									.update(archives.get(`${pkg.name}-${pkg.version}`)!)
									.digest('base64')}`,
								shasum: createHash('sha1')
									.update(archives.get(`${pkg.name}-${pkg.version}`)!)
									.digest('hex'),
							},
						},
					]),
				),
			}),
		)
	})
	try {
		await mkdir(resolve(root, 'node_modules/@pluxel'), { recursive: true })
		const capnweb = resolve(workspace, 'packages/host/node_modules/capnweb')
		const { version: capnwebVersion } = JSON.parse(
			await readFile(resolve(capnweb, 'package.json'), 'utf8'),
		)
		await writeFile(
			resolve(root, 'package.json'),
			JSON.stringify({
				name: 'immutable-installation-host',
				type: 'module',
				dependencies: { capnweb: capnwebVersion },
			}),
		)
		await symlink(capnweb, resolve(root, 'node_modules/capnweb'))
		await symlink(
			resolve(workspace, 'plugins/package-manager'),
			resolve(root, 'node_modules/@pluxel/plugin-package-manager'),
		)
		for (const name of ['core', 'host', 'services', 'commands', 'workbench'])
			await symlink(
				resolve(workspace, 'packages', name),
				resolve(root, 'node_modules/@pluxel', name),
			)
		await symlink(
			resolve(workspace, 'packages/services/node_modules/elysia'),
			resolve(root, 'node_modules/elysia'),
		)
		await mkdir(resolve(root, 'node_modules/fixture-plain'))
		await writeFile(
			resolve(root, 'node_modules/fixture-plain/package.json'),
			JSON.stringify({ name: 'fixture-plain', type: 'module', exports: './index.mjs' }),
		)
		await writeFile(
			resolve(root, 'node_modules/fixture-plain/index.mjs'),
			"export const value = 'plain-v1'",
		)
		for (const pkg of packages) {
			const directory = resolve(root, `${pkg.name}-${pkg.version}`)
			await mkdir(resolve(directory, 'package'), { recursive: true })
			await writeFile(
				resolve(directory, 'package/package.json'),
				JSON.stringify({
					...pkg,
					peerDependencies: { '@pluxel/core': '*' },
					type: 'module',
					exports: './index.mjs',
					pluxel: { artifactRoot: '.', nodeArtifacts: true },
				}),
			)
			await writeFile(
				resolve(directory, 'package/index.mjs'),
				`${compiledPlugin(pkg.name, pkg.version, 'fixture-p' in pkg.dependencies)}\n${'fixture-p' in pkg.dependencies ? "import * as provider from 'fixture-p'; export { provider };" : ''}
export const version = '${pkg.version}'; export const late = () => import('./late.mjs');
export const resource = () => import('node:fs/promises').then(fs => fs.readFile(new URL('./resource.txt', import.meta.url), 'utf8'));`,
			)
			await mkdir(resolve(directory, 'package/artifacts/node'), { recursive: true })
			const worker = `export default () => '${pkg.version}'`
			await writeFile(
				resolve(directory, 'package/artifacts/node/node-aaaaaaaaaaaaaaaa.mjs'),
				worker,
			)
			await writeFile(
				resolve(directory, 'package/artifacts/node/pluxel-node-artifacts.json'),
				JSON.stringify({
					version: 1,
					artifacts: [
						{
							key: 'node-aaaaaaaaaaaaaaaa',
							file: 'node-aaaaaaaaaaaaaaaa.mjs',
							sha256: createHash('sha256').update(worker).digest('hex'),
						},
					],
				}),
			)
			await writeFile(
				resolve(directory, 'package/late.mjs'),
				`export const version = '${pkg.version}'`,
			)
			await writeFile(resolve(directory, 'package/resource.txt'), pkg.version)
			await promisify(execFile)('tar', [
				'-czf',
				resolve(directory, 'package.tgz'),
				'-C',
				directory,
				'package',
			])
			archives.set(`${pkg.name}-${pkg.version}`, await readFile(resolve(directory, 'package.tgz')))
		}
		await new Promise<void>((ready) => registry.listen(0, '127.0.0.1', ready))
		const url = `http://127.0.0.1:${(registry.address() as { port: number }).port}/`
		const engine = await loadPnpmEngine()
		const install = async (revision: string, dependencies: Record<string, string>) => {
			const dir = resolve(root, revision)
			await mkdir(dir)
			const config = engine.readConfig({ dir })
			await engine.install({
				dir,
				projects: [{ rootDir: dir, manifest: { name: 'fixture', private: true, dependencies } }],
				registries: { default: url },
				storeDir: resolve(root, 'store'),
				cacheDir: resolve(root, 'cache'),
				nodeLinker: 'isolated',
				enableGlobalVirtualStore: true,
				globalVirtualStoreDir: resolve(root, 'slots'),
				ignoreScripts: true,
				minimumReleaseAge: 0,
				networkConfig: { fetchRetries: 0, strictSsl: config.strictSsl },
			})
			return dir
		}
		const first = await install('revision-1', { 'fixture-a': '1.0.0', 'fixture-b': '1.0.0' })
		const oldA = await realpath(resolve(first, 'node_modules/fixture-a/index.mjs'))
		const oldB = await realpath(resolve(first, 'node_modules/fixture-b/index.mjs'))
		const second = await install('revision-2', { 'fixture-a': '2.0.0', 'fixture-b': '1.0.0' })
		const newA = await realpath(resolve(second, 'node_modules/fixture-a/index.mjs'))
		expect(newA).not.toBe(oldA)
		expect(await realpath(resolve(second, 'node_modules/fixture-b/index.mjs'))).toBe(oldB)
		await install('revision-3', { 'fixture-b': '1.0.0' })
		await promisify(execFile)(process.execPath, [
			'--input-type=module',
			'-e',
			`import assert from 'node:assert/strict'; const [a1,a2,b1]=await Promise.all(${JSON.stringify([oldA, newA, oldB].map((file) => pathToFileURL(file).href))}.map(file=>import(file))); assert.equal(a1.provider,b1.provider);assert.equal(a2.provider,b1.provider);assert.equal((await a1.late()).version,'1.0.0');assert.equal(await a1.resource(),'1.0.0');`,
		])
		const rootDir = resolve(root, 'managed')
		const managedEngine = {
			...engine,
			readConfig(input: { dir: string }) {
				return {
					...engine.readConfig(input),
					registries: [{ name: 'default', url }],
					storeDir: resolve(root, 'store'),
					cacheDir: resolve(root, 'cache'),
					fetchRetries: 0,
				}
			},
		}
		const options = {
			rootDir,
			ignoreScripts: true,
			allowBuilds: [] as string[],
			minimumReleaseAgeMinutes: 0,
			markets: [{ id: 'community', url: new URL('community', url).href }],
		}
		const store = new ManagedPackageStore(managedEngine, options)
		await store.initialize()
		try {
			await expect(
				new ManagedPackageStore(managedEngine, options).initialize(),
			).rejects.toMatchObject({ code: 'PACKAGE_STORE_WRITER_CONFLICT' })
			expect(await store.install(['fixture-b@2.0.0'])).toMatchObject({ ok: true })
			const common = {
				marketId: 'community',
				registry: new URL(url).origin,
			}
			const prepareSelection = async (version: string) => {
				const selected = await store.prepareMarketInstall([
					{ ...common, name: 'fixture-a', version },
					{ ...common, name: 'fixture-b', version: '1.0.0' },
				])
				if (selected.ok === false) throw new Error(JSON.stringify(selected.failed))
				return selected.plan
			}
			const selected = await prepareSelection('1.0.0')
			expect(selected.packages).toMatchObject([
				{ name: 'fixture-a', previousVersion: null, version: '1.0.0', market: common },
				{ name: 'fixture-b', previousVersion: '2.0.0', version: '1.0.0', market: common },
			])
			const beforeConfirmation = await store.snapshot()
			expect(beforeConfirmation.packages.map(({ name }) => name)).toEqual(['fixture-b'])
			expect(beforeConfirmation.packages[0]).not.toHaveProperty('marketRegistry')
			expect(await store.confirmInstall(selected.id)).toMatchObject({
				ok: true,
				succeeded: ['fixture-a', 'fixture-b'],
			})
			const entry = (name: string) =>
				resolve(store.entriesDir, Buffer.from(name).toString('base64url') + '.mjs')
			const beforeUpgrade = await store.snapshot()
			expect(beforeUpgrade.packages).toMatchObject([
				{ name: 'fixture-a', installedVersion: '1.0.0', marketRegistry: common.registry },
				{ name: 'fixture-b', installedVersion: '1.0.0', marketRegistry: common.registry },
			])
			const originalEntry = await readFile(entry('fixture-a'), 'utf8')
			const upgrade = await prepareSelection('2.0.0')
			expect(upgrade.packages).toMatchObject([
				{ name: 'fixture-a', previousVersion: '1.0.0', version: '2.0.0', changed: true },
				{ name: 'fixture-b', previousVersion: '1.0.0', version: '1.0.0', changed: false },
			])
			expect(await store.snapshot()).toEqual(beforeUpgrade)
			expect(await readFile(entry('fixture-a'), 'utf8')).toBe(originalEntry)
			expect(await store.confirmInstall(upgrade.id)).toMatchObject({ ok: true })
			const afterUpgrade = await store.snapshot()
			expect(afterUpgrade.packages).toMatchObject([
				{ name: 'fixture-a', installedVersion: '2.0.0' },
				{ name: 'fixture-b', installedVersion: '1.0.0' },
			])
			expect(await readFile(entry('fixture-a'), 'utf8')).not.toBe(originalEntry)
			// The production Vite scenario starts at the original release and changes it live.
			const restore = await prepareSelection('1.0.0')
			expect(await store.confirmInstall(restore.id)).toMatchObject({ ok: true })
			const inner = async (name: string) =>
				resolve(store.entriesDir, /from "(.+?)"/.exec(await readFile(entry(name), 'utf8'))![1]!)
			await store.close()
			const persisted = new ManagedPackageStore(managedEngine, options)
			await persisted.initialize()
			try {
				const persistedSnapshot = await persisted.snapshot()
				expect(persistedSnapshot.packages).toMatchObject([
					{ name: 'fixture-a', marketRegistry: common.registry },
					{ name: 'fixture-b', marketRegistry: common.registry },
				])
			} finally {
				await persisted.close()
			}
			await writeFile(
				resolve(rootDir, '.npmrc'),
				`registry=${url}\nstore-dir=${resolve(root, 'store')}\ncache-dir=${resolve(root, 'cache')}\nfetch-retries=0\n`,
			)
			const portServer = createPortServer()
			await new Promise<void>((ready) => portServer.listen(0, '127.0.0.1', ready))
			const port = (portServer.address() as { port: number }).port
			await new Promise<void>((closed) => portServer.close(() => closed()))
			await writeFile(resolve(root, 'fixed.mjs'), "export const value = 'fixed-v1'")
			const node = (name: string, exportName: string) => ({
				definition: { entry: { kind: 'package-root', packageName: name }, exportName },
				variant: 'default',
			})
			await writeFile(
				resolve(root, 'app.mjs'),
				`import {defineHostApplication} from '@pluxel/host'; import { elysia } from '@pluxel/services/elysia'; import { commands } from '@pluxel/services/commands'; import { nodeModules } from '@pluxel/services/node'; import { workers } from '@pluxel/services/workers'; import {value} from './fixed.mjs'; import {PackageManagerPlugin} from '@pluxel/plugin-package-manager'; export default defineHostApplication(() => ({plugins: [{plugin:PackageManagerPlugin,autoStart:true,config:{rootDir:${JSON.stringify(rootDir)},minimumReleaseAgeMinutes:0}}], pluginNodes:${JSON.stringify([node('fixture-a', 'A'), node('fixture-b', 'B')].map(({ definition }) => ({ definition, autoStart: true })))}, sources: [{directory:'./managed/entries',include:['*.mjs']}], services:[elysia(), commands(), nodeModules(), workers()], prepare({host,startup}) { startup.bindings.capture(host, value) }}))`,
			)
			await writeFile(
				resolve(root, 'vite.config.mjs'),
				`import {vitePreset} from '@pluxel/services/vite'; export default {logLevel:'error',cacheDir:'.vite',plugins:vitePreset({entry:'app.mjs',bindings:{capture:host=>{globalThis.__productionHost=host}}})}`,
			)
			const child = fork(
				fileURLToPath(new URL('./production-vite.smoke.mjs', import.meta.url)),
				[root],
				{
					env: {
						...process.env,
						NODE_ENV: 'production',
						PLUXEL_HOST_PORT: String(port),
						PLUXEL_HOST_BIND: '127.0.0.1',
					},
					execArgv: [],
					stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
				},
			)
			productionChild = child
			child.stdout!.resume()
			let stderr = ''
			child.stderr!.on('data', (chunk) => {
				stderr += String(chunk)
			})
			type Reply = {
				ready?: boolean
				command?: string
				ok?: boolean
				error?: string
				result?: unknown
				samples?: readonly { stage: string; durationMs: number; rssMiB: number }[]
			}
			const received = (stage: string) =>
				new Promise<Reply>((replyReady, reject) => {
					const cleanup = () => {
						clearTimeout(timeout)
						child.off('message', done)
						child.off('exit', died)
					}
					const timeout = setTimeout(() => {
						cleanup()
						reject(new Error(`Production Vite timed out during ${stage}: ${stderr}`))
					}, 30_000)
					const done = (message: Reply) => {
						cleanup()
						if (message.error) {
							reject(new Error(message.error + '\n' + stderr))
						} else {
							replyReady(message)
						}
					}
					const died = (code: number | null) => {
						cleanup()
						reject(new Error('Production Vite exited ' + code + ': ' + stderr))
					}
					child.once('message', done)
					child.once('exit', died)
				})
			const ready = received('startup')
			await expect(ready).resolves.toMatchObject({ ready: true })
			const publish = async (operation: 'install' | 'remove', specs: string[]) => {
				const reply = received(`${operation}: ${specs.join(', ')}`)
				child.send({ operation, specs })
				const response = await reply
				return response.result
			}
			const stage = async (value: string) => {
				const reply = received(value)
				child.send(value)
				const result = await reply
				expect(result).toMatchObject({ command: value, ok: true })
				return result
			}
			const nativeWriter = `import {ManagedPackageStore} from ${JSON.stringify(new URL('../src/store.ts', import.meta.url).href)}; const store=new ManagedPackageStore({},${JSON.stringify(options)}); try {await store.initialize();process.exitCode=1} catch(error) { if(error.code!=='PACKAGE_STORE_WRITER_CONFLICT')throw error }`
			await promisify(execFile)(
				process.execPath,
				['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', nativeWriter],
				{ cwd: process.cwd() },
			)
			const oldInnerA = await inner('fixture-a')
			const oldInnerB = await inner('fixture-b')
			const beforeB = await stat(entry('fixture-b'))
			const bytesB = await readFile(entry('fixture-b'), 'utf8')
			expect(await publish('install', ['fixture-a@2.0.0'])).toMatchObject({ ok: true })
			expect(await readFile(entry('fixture-b'), 'utf8')).toBe(bytesB)
			expect(await stat(entry('fixture-b'))).toMatchObject({
				ino: beforeB.ino,
				mtimeMs: beforeB.mtimeMs,
			})
			await stage('a2')
			const secondInnerA = await inner('fixture-a')
			expect(secondInnerA).not.toBe(oldInnerA)
			expect(await publish('install', ['fixture-a@3.0.0', 'fixture-b@2.0.0'])).toMatchObject({
				ok: true,
			})
			await stage('p2')
			const thirdInnerA = await inner('fixture-a')
			const secondInnerB = await inner('fixture-b')
			expect(secondInnerB).not.toBe(oldInnerB)
			expect(await publish('install', ['fixture-b@3.0.0'])).toMatchObject({ ok: true })
			await stage('b3')
			const unrelatedB = {
				bytes: await readFile(entry('fixture-b'), 'utf8'),
				stat: await stat(entry('fixture-b')),
				inner: await inner('fixture-b'),
			}
			expect(await publish('install', ['fixture-a@4.0.0'])).toMatchObject({ ok: true })
			await stage('p3')
			expect(await readFile(entry('fixture-b'), 'utf8')).toBe(unrelatedB.bytes)
			expect(await stat(entry('fixture-b'))).toMatchObject({
				ino: unrelatedB.stat.ino,
				mtimeMs: unrelatedB.stat.mtimeMs,
			})
			expect(await inner('fixture-b')).toBe(unrelatedB.inner)
			expect(await publish('remove', ['fixture-a'])).toMatchObject({ ok: true })
			await stage('remove')
			const closed = await stage('close')
			if (!closed.samples) throw new Error('Missing runtime metrics')
			expect(closed.samples.length).toBeGreaterThan(5)
			if (process.env.PLUXEL_RUNTIME_METRICS_FILE)
				await writeFile(
					process.env.PLUXEL_RUNTIME_METRICS_FILE,
					JSON.stringify(closed.samples, null, 2),
				)
			if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
			expect({ code: child.exitCode, signal: child.signalCode }).toEqual({
				code: 0,
				signal: null,
			})
			await store.close()
			const script = `import assert from 'node:assert/strict';
const [a1,a2,a3,b1,b2] = await Promise.all(${JSON.stringify([oldInnerA, secondInnerA, thirdInnerA, oldInnerB, secondInnerB].map((file) => pathToFileURL(file).href))}.map(url => import(url)));
assert.equal(a1.provider,b1.provider); assert.equal(a2.provider,b1.provider); assert.equal(a3.provider,b2.provider); assert.notEqual(a1.provider,a3.provider);
assert.equal((await a1.late()).version,'1.0.0'); assert.equal(await a1.resource(),'1.0.0');`
			await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script])
			const reopened = new ManagedPackageStore(managedEngine, options)
			await reopened.initialize()
			const reopenedSnapshot = await reopened.snapshot()
			expect(reopenedSnapshot.packages).toMatchObject([
				{ name: 'fixture-b', installedVersion: '3.0.0' },
			])
			expect(reopenedSnapshot.packages[0]).not.toHaveProperty('marketRegistry')
			await reopened.close()
		} finally {
			await store.close()
		}
	} finally {
		await stopChild()
		registry.closeAllConnections()
		await new Promise<void>((closed) => registry.close(() => closed()))
		await rm(root, { recursive: true, force: true })
	}
}, 90_000)

function compiledPlugin(name: string, version: string, dependsOnP: boolean): string {
	const exportName = name === 'fixture-p' ? 'P' : name === 'fixture-a' ? 'A' : 'B'
	const definition = { entry: { kind: 'package-root', packageName: name }, exportName }
	const provider = { entry: { kind: 'package-root', packageName: 'fixture-p' }, exportName: 'P' }
	return `import {BasePlugin,Plugin} from '@pluxel/core'; import {__setPluginDefinition} from '@pluxel/core/toolchain';
 ${name === 'fixture-p' ? '' : `${dependsOnP ? "import {P} from 'fixture-p'; export {P};" : ''} ${name === 'fixture-a' ? "import {value as plain} from 'fixture-plain';" : "const plain = 'unrelated-b';"} import {ElysiaApp} from '@pluxel/services/elysia'; import {websocket} from 'elysia/websocket'; import {Workers,defineWorkerTask} from '@pluxel/services/workers'; const task=defineWorkerTask(import.meta.url,'./removed-source.ts','node-aaaaaaaaaaaaaaaa');`}
 class ${exportName} extends BasePlugin {
 version='${version}';
 late(){ return late() }
 resource(){ return resource() }
 ${name === 'fixture-p' ? '' : `${dependsOnP ? 'constructor(provider){super();this.provider=provider};' : ''} plain=plain; async init(){ this.workerValue=await this.ctx.service(Workers).run(task,null); this.ctx.service(ElysiaApp).use(websocket()).get('/${exportName.toLowerCase()}',()=>this.version).ws('/${exportName.toLowerCase()}/socket',{open:socket=>socket.send(this.version)}) }`}
 }; Plugin()(${exportName}); __setPluginDefinition(${exportName},{abiVersion:2,kind:'plugin',definition:${JSON.stringify(definition)},constructorRequires:${JSON.stringify(dependsOnP ? [provider] : [])}}); export {${exportName}};`
}
