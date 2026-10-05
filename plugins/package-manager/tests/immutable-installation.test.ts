import { createHash } from 'node:crypto'
import { execFile, fork } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { createServer as createPortServer } from 'node:net'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { ManagedPackageStore } from '../src/store.ts'
import { loadPnpmEngine } from '../src/pnpm-engine.ts'

it('pnpm shares immutable dependency slots across private installations', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-immutable-install-'))
	const workspace = fileURLToPath(new URL('../../../', import.meta.url))
	let productionChild: ReturnType<typeof fork> | undefined
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
		const path = decodeURIComponent(request.url?.split('?')[0] ?? '')
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
		await symlink(
			resolve(workspace, 'plugins/package-manager'),
			resolve(root, 'node_modules/@pluxel/package-manager'),
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
		}
		const store = new ManagedPackageStore(managedEngine, options)
		await store.initialize()
		try {
			await expect(
				new ManagedPackageStore(managedEngine, options).initialize(),
			).rejects.toMatchObject({ code: 'PACKAGE_STORE_WRITER_CONFLICT' })
			expect(await store.install(['fixture-a@1.0.0', 'fixture-b@1.0.0'])).toMatchObject({
				ok: true,
			})
			const entry = (name: string) =>
				resolve(store.entriesDir, Buffer.from(name).toString('base64url') + '.mjs')
			const inner = async (name: string) =>
				resolve(store.entriesDir, /from "(.+?)"/.exec(await readFile(entry(name), 'utf8'))![1]!)
			await store.close()
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
				`import {defineHostApplication} from '@pluxel/host'; import {pluginSource} from '@pluxel/host/sources'; import {standardServices} from '@pluxel/services'; import {value} from './fixed.mjs'; import {PackageManagerPlugin} from '@pluxel/package-manager'; export default defineHostApplication(() => ({plugins: [PackageManagerPlugin], configRecords:{initial:[{owner:${JSON.stringify(node('@pluxel/package-manager', 'PackageManagerPlugin'))},config:{rootDir:${JSON.stringify(rootDir)},minimumReleaseAgeMinutes:0}}]}, sources: [pluginSource({kind:'directory',path:'./managed/entries',include:['*.mjs']})], services:standardServices({persistence:{mode:'memory'}}), state:{initial:{autoStart:${JSON.stringify([node('fixture-a', 'A'), node('fixture-b', 'B'), node('@pluxel/package-manager', 'PackageManagerPlugin')])}}}, prepare({host,startup}) { startup.bindings.capture(host, value) }}))`,
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
			const received = () =>
				new Promise<Reply>((replyReady, reject) => {
					const done = (message: Reply) => {
						child.off('exit', died)
						if (message.error) {
							reject(new Error(message.error + '\n' + stderr))
						} else {
							replyReady(message)
						}
					}
					const died = (code: number | null) => {
						child.off('message', done)
						reject(new Error('Production Vite exited ' + code + ': ' + stderr))
					}
					child.once('message', done)
					child.once('exit', died)
				})
			const ready = received()
			await expect(ready).resolves.toMatchObject({ ready: true })
			const publish = async (operation: 'install' | 'remove', specs: string[]) => {
				const reply = received()
				child.send({ operation, specs })
				const response = await reply
				return response.result
			}
			const stage = async (value: string) => {
				const reply = received()
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
			await reopened.close()
		} finally {
			await store.close()
		}
	} finally {
		if (
			productionChild &&
			productionChild.exitCode === null &&
			productionChild.signalCode === null
		) {
			productionChild.kill()
			await once(productionChild, 'exit')
		}
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
 ${name === 'fixture-p' ? '' : `${dependsOnP ? 'constructor(provider){super();this.provider=provider};' : ''} plain=plain; async init(){ this.workerValue=await this.ctx.require(Workers).run(task,null); this.ctx.require(ElysiaApp).use(websocket()).get('/${exportName.toLowerCase()}',()=>this.version).ws('/${exportName.toLowerCase()}/socket',{open:socket=>socket.send(this.version)}) }`}
 }; Plugin()(${exportName}); __setPluginDefinition(${exportName},{abiVersion:2,kind:'plugin',definition:${JSON.stringify(definition)},constructorRequires:${JSON.stringify(dependsOnP ? [provider] : [])}}); export {${exportName}};`
}
