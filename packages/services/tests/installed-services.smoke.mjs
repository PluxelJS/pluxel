import { execFile as execFileCallback } from 'node:child_process'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { expect, it } from 'vitest'
import { build } from 'vite'

const execFile = promisify(execFileCallback)
const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const UNSELECTED_BACKEND_LOAD_PATTERN =
	/\/node_modules\/(?:@logtape\/(?:file|pretty)|capnweb|@pluxel\/workbench)(?:\/|$)|\/(?:logging|management)(?:\/|[-.])/

it('does not confuse a pnpm peer suffix with a loaded capnweb module', () => {
	const packageUrl =
		'file:///tmp/node_modules/.pnpm/@pluxel+services@file+services.tgz_capnweb@0.12.0/node_modules/@pluxel/services/dist/vault.mjs'
	expect(UNSELECTED_BACKEND_LOAD_PATTERN.test(packageUrl)).toBe(false)
	expect(
		UNSELECTED_BACKEND_LOAD_PATTERN.test(
			'file:///tmp/node_modules/.pnpm/capnweb@0.12.0/node_modules/capnweb/dist/index.js',
		),
	).toBe(true)
})
const run = async (file, args, cwd) => {
	try {
		return await execFile(file, args, { cwd, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 })
	} catch (error) {
		throw new Error(`${error.message}\n${error.stdout ?? ''}`, { cause: error })
	}
}

const checkOptionalDeclarations = async (root) => {
	const declarations = await run(
		join(workspace, 'node_modules/.bin/tsc'),
		['--project', 'tsconfig.json'],
		root,
	)
		.then(() => ({ failed: false, diagnostics: [] }))
		.catch((error) => ({
			failed: true,
			diagnostics: String(error.cause?.stdout ?? '')
				.trim()
				.split(/\r?\n/),
		}))
	// capnweb 0.12.0 (also upstream main) spreads a Promise union as a tuple tail.
	// Keep library checking enabled: only the two confirmed upstream diagnostics are allowed.
	const upstreamDiagnostics = [333, 469].map(
		(column) =>
			`node_modules/.pnpm/capnweb@0.12.0/node_modules/capnweb/dist/index.d.ts(63,${column}): error TS2574: A rest element type must be an array type.`,
	)
	expect(declarations.diagnostics).toEqual(declarations.failed ? upstreamDiagnostics : [])
	if (declarations.failed)
		process.stdout.write(
			'KNOWN_UPSTREAM_CAPNWEB_DECLARATION_ERRORS: 2 TS2574 in capnweb 0.12.0; all other installed declarations checked\n',
		)
}

const checkInstalledBrowserFs = async (root) => {
	const fixture = join(root, 'browser-fs.mjs')
	await writeFile(
		fixture,
		await readFile(new URL('./fixtures/installed-fs-browser.mjs', import.meta.url), 'utf8'),
	)
	const result = await build({
		root,
		configFile: false,
		logLevel: 'error',
		build: {
			write: false,
			target: 'esnext',
			minify: false,
			lib: { entry: fixture, formats: ['es'] },
		},
	})
	const output = (Array.isArray(result) ? result[0] : result).output
	const entry = output.find((item) => item.type === 'chunk' && item.isEntry)
	expect(entry).toBeDefined()
	const scripts = new Map(
		output.filter((item) => item.type === 'chunk').map((item) => [item.fileName, item.code]),
	)
	const browser = await chromium.connect(
		process.env.PLAYWRIGHT_WS_ENDPOINT ?? 'ws://127.0.0.1:3000',
		{ timeout: 10_000 },
	)
	let context
	try {
		context = await browser.newContext()
		const requests = []
		await context.route('https://installed-fs.test/**', (route) => {
			const path = new URL(route.request().url()).pathname.slice(1)
			requests.push(path)
			return route.fulfill(
				path === ''
					? { contentType: 'text/html', body: '<!doctype html><title>Installed filesystem</title>' }
					: { contentType: 'text/javascript', body: scripts.get(path) ?? '' },
			)
		})
		const page = await context.newPage()
		const errors = []
		page.on('pageerror', (error) => errors.push(error.message))
		await page.goto('https://installed-fs.test/')
		// Keep the browser import outside Vitest's SSR transformation of this test module.
		const load = `import(${JSON.stringify(`/${entry.fileName}`)})`
		expect(await page.evaluate(`${load}.then((runtime) => runtime.memory())`)).toBe('MEMORY')
		for (const file of entry.dynamicImports) expect(requests).not.toContain(file)
		expect(await page.evaluate(`${load}.then((runtime) => runtime.persisted())`)).toEqual({
			content: 'PERSISTED',
			empty: '',
			binary: [0, 1, 255],
			readonly: 'EROFS',
			missingOtherOwner: 'ENOENT',
			rounds: Array.from({ length: 3 }, () => ({
				content: 'PERSISTED',
				otherOwner: 'OWNER-B',
				closed: 'EBADF',
			})),
		})
		const bootstrap = await page.evaluate(`${load}.then((runtime) => runtime.corruptConfig())`)
		expect(bootstrap).toMatchObject({
			cause: 'SyntaxError',
			closed: 'EBADF',
			bytes: [123, 10, 0, 255],
		})
		expect(bootstrap.failure).toMatch(/\[ConfigService\] Cannot load config\.json:/)
		expect(errors).toEqual([])
	} finally {
		try {
			await context?.close()
		} finally {
			await browser.close()
		}
	}
}

const packBaseServices = async (root) => {
	const dependencies = {}
	// Include Host's publication-time dependency on valibot-form in the base closure.
	for (const name of ['core', 'host', 'commands', 'services', 'valibot-form']) {
		const tarball = join(root, `${name}.tgz`)
		await run('pnpm', ['pack', '--out', tarball], join(workspace, 'packages', name))
		dependencies[name === 'valibot-form' ? name : `@pluxel/${name}`] = `file:${tarball}`
	}
	return dependencies
}

it('ships the patched filesystem to independent Node and browser consumers with its declarations and notices', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-fs-consumer-'))
	try {
		const dependencies = await packBaseServices(root)
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: 'independent-service-consumer',
				private: true,
				type: 'module',
				dependencies,
			}),
		)
		await writeFile(
			join(root, 'pnpm-workspace.yaml'),
			JSON.stringify({ packages: ['.'], overrides: dependencies }),
		)
		await run('pnpm', ['--dir', root, 'install', '--prefer-offline', '--ignore-scripts'], workspace)
		for (const name of Object.keys(dependencies))
			expect(await realpath(join(root, 'node_modules', name))).not.toContain(workspace)
		const installed = await readdir(join(root, 'node_modules/.pnpm'))
		expect(installed.some((name) => name.startsWith('elysia@'))).toBe(false)
		expect(installed.some((name) => /^(?:@zenfs\+|kerium@|utilium@|memium@)/.test(name))).toBe(
			false,
		)
		const servicePackage = await realpath(join(root, 'node_modules/@pluxel/services'))
		for (const file of [
			'README.md',
			'patches/@zenfs__core@2.8.3.patch',
			'patches/@zenfs__dom@1.2.14.patch',
			'@zenfs/core/LICENSE.md',
			'@zenfs/dom/LICENSE.md',
			'buffer/LICENSE',
		]) {
			const notice = await readFile(join(servicePackage, 'dist/third-party', file), 'utf8')
			expect(notice.length).toBeGreaterThan(0)
		}
		await writeFile(join(root, 'fs.mjs'), fsConsumer)
		const filesystem = await run(process.execPath, ['fs.mjs'], root)
		expect(filesystem.stdout).toContain('ISOLATED_FS_OK')

		await writeFile(join(root, 'consumer.ts'), fsTypeConsumer)
		await writeFile(
			join(root, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					skipLibCheck: false,
					noEmit: true,
					module: 'NodeNext',
					target: 'ESNext',
					types: [],
				},
				files: ['consumer.ts'],
			}),
		)
		await run(join(workspace, 'node_modules/.bin/tsc'), ['--project', 'tsconfig.json'], root)
		await checkInstalledBrowserFs(root)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 90_000)

it('consumes real service tarballs outside the workspace with isolated declarations and lazy ESM imports', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-services-consumer-'))
	try {
		const dependencies = await packBaseServices(root)
		const nodeTypes = JSON.parse(
			await readFile(
				join(workspace, 'packages/services/node_modules/@types/node/package.json'),
				'utf8',
			),
		).version
		const elysiaRequire = createRequire(
			await realpath(join(workspace, 'packages/services/node_modules/elysia/package.json')),
		)
		const bunTypes = JSON.parse(
			await readFile(elysiaRequire.resolve('@types/bun/package.json'), 'utf8'),
		).version
		// Retain the existing optional HTTP fixture; the FS receiver test installs neither package.
		const typeboxVersion = '1.3.23'
		const elysiaVersion = JSON.parse(
			await readFile(join(workspace, 'packages/services/node_modules/elysia/package.json'), 'utf8'),
		).version
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: 'independent-service-consumer',
				private: true,
				type: 'module',
				dependencies,
				devDependencies: {
					'@types/node': nodeTypes,
					'@types/bun': bunTypes,
					elysia: elysiaVersion,
					typebox: typeboxVersion,
				},
			}),
		)
		await writeFile(
			join(root, 'pnpm-workspace.yaml'),
			JSON.stringify({ packages: ['.'], overrides: { ...dependencies, typebox: typeboxVersion } }),
		)
		await run('pnpm', ['--dir', root, 'install', '--prefer-offline', '--ignore-scripts'], workspace)
		for (const name of Object.keys(dependencies))
			expect(await realpath(join(root, 'node_modules', name))).not.toContain(workspace)
		const installed = await readdir(join(root, 'node_modules/.pnpm'))
		expect(
			installed.some((name) => /^(?:@pluxel\+runtime|pg@|@electric-sql\+pglite)/.test(name)),
		).toBe(false)
		await writeFile(join(root, 'consumer.mjs'), consumer)
		const result = await run(process.execPath, ['consumer.mjs'], root)
		expect(result.stdout).toContain('ISOLATED_SERVICES_OK')
		await writeFile(join(root, 'consumer.ts'), typeConsumer)
		await writeFile(
			join(root, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					strict: true,
					noEmit: true,
					module: 'NodeNext',
					target: 'ESNext',
					types: ['node', 'bun'],
				},
				files: ['consumer.ts'],
			}),
		)
		await run(join(workspace, 'node_modules/.bin/tsc'), ['--project', 'tsconfig.json'], root)
		// The same base installation serves explicit, standard, and headless Management compositions.
		await writeFile(join(root, 'standard.mjs'), standardServicesConsumer)
		const standardResult = await run(process.execPath, ['standard.mjs'], root)
		expect(standardResult.stdout).toContain('ISOLATED_STANDARD_SERVICES_OK')
		// Management must work before Workbench or browser peers are installed.
		await writeFile(join(root, 'headless.mjs'), headlessManagementConsumer)
		const headless = await run(process.execPath, ['headless.mjs'], root)
		expect(headless.stdout).toContain('ISOLATED_MANAGEMENT_OK')
		await writeFile(
			join(root, 'consumer.ts'),
			typeConsumer + headlessManagementConsumer + headlessManagementTypes,
		)
		await checkOptionalDeclarations(root)
		// Expand the same genuinely installed consumer to the optional UI/development plane.
		for (const name of ['workbench', 'rolldown', 'test']) {
			const tarball = join(root, `${name}.tgz`)
			await run('pnpm', ['pack', '--out', tarball], join(workspace, 'packages', name))
			dependencies[`@pluxel/${name}`] = `file:${tarball}`
		}
		const reactTypes = JSON.parse(
			await readFile(
				join(workspace, 'packages/workbench/node_modules/@types/react/package.json'),
				'utf8',
			),
		).version

		const viteVersion = JSON.parse(
			await readFile(join(workspace, 'packages/host-vite/node_modules/vite/package.json'), 'utf8'),
		).version
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({
				name: 'independent-service-consumer',
				private: true,
				type: 'module',
				dependencies,
				devDependencies: {
					'@types/node': nodeTypes,
					'@types/bun': bunTypes,
					typebox: typeboxVersion,
					'@types/react': reactTypes,
					vite: viteVersion,
					elysia: elysiaVersion,
				},
			}),
		)
		await writeFile(
			join(root, 'pnpm-workspace.yaml'),
			JSON.stringify({ packages: ['.'], overrides: { ...dependencies, typebox: typeboxVersion } }),
		)
		await run('pnpm', ['--dir', root, 'install', '--prefer-offline', '--ignore-scripts'], workspace)
		await writeFile(join(root, 'node-test.mjs'), nodeTestConsumer)
		const nodeTestResult = await run(process.execPath, ['node-test.mjs'], root)
		expect(nodeTestResult.stdout).toContain('ISOLATED_NODE_TEST_OK')
		const hostViteTarball = join(root, 'host-vite.tgz')
		await run('pnpm', ['pack', '--out', hostViteTarball], join(workspace, 'packages/host-vite'))
		dependencies['@pluxel/host-vite'] = `file:${hostViteTarball}`
		const consumerManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ ...consumerManifest, dependencies }),
		)
		await writeFile(
			join(root, 'pnpm-workspace.yaml'),
			JSON.stringify({ packages: ['.'], overrides: { ...dependencies, typebox: typeboxVersion } }),
		)
		await run('pnpm', ['--dir', root, 'install', '--prefer-offline', '--ignore-scripts'], workspace)
		await writeFile(join(root, 'bare-console.mjs'), bareConsoleConsumer)
		const bareConsoleResult = await run(process.execPath, ['bare-console.mjs'], root)
		expect(bareConsoleResult.stdout).toContain('ISOLATED_BARE_CONSOLE_OK')
		await writeFile(join(root, 'optional.mjs'), optionalConsumer)
		const optionalResult = await run(process.execPath, ['optional.mjs'], root)
		expect(optionalResult.stdout).toContain('ISOLATED_WORKBENCH_OK')
		await writeFile(join(root, 'consumer.ts'), typeConsumer + optionalTypeConsumer)
		await checkOptionalDeclarations(root)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 180_000)

const fsTypeConsumer = `
import * as nativeFs from 'node:fs'
import {createHost} from '@pluxel/host/browser'
import {Fs,fs,InMemory,Passthrough,type FsPromises,type FsServiceConfig} from '@pluxel/services/fs'
import {IndexedDB} from '@pluxel/services/fs/browser'
const nodeConfig={backend:Passthrough,fs:nativeFs,prefix:'/data',readOnly:true} satisfies FsServiceConfig
const browserConfig={backend:IndexedDB,storeName:'profile',readOnly:true} satisfies FsServiceConfig
// @ts-expect-error Passthrough requires its native fs and prefix options.
const missingNativeConfig:FsServiceConfig={backend:Passthrough}
const host=await createHost({plugins:[],services:[fs({backend:InMemory})]})
const io:FsPromises=await host.ctx.require(Fs).directory('documents')
const bytes:Uint8Array=await io.readFile('value')
const text:string=await io.readFile('value','utf8')
void nodeConfig;void browserConfig;void missingNativeConfig;void bytes;void text
await host.close()
`

const fsConsumer = `
import assert from 'node:assert/strict'
import * as nativeFs from 'node:fs'
import { registerHooks } from 'node:module'
import { createHost } from '@pluxel/host'
import { BasePlugin, Plugin } from '@pluxel/core'
import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
import { Fs, PluginFs, fs, InMemory, Passthrough, writeFileAtomic } from '@pluxel/services/fs'
const hooks = registerHooks({ load(url, context, next) {
 assert.equal(/\\/node_modules\\/(?:@zenfs\\/|kerium\\/|utilium\\/|memium\\/)/.test(url), false, 'Filesystem must use its bundled patched implementation')
 return next(url, context)
} })
const views = new Map()
class Owner extends BasePlugin {
 async init() {
  assert.equal(this.ctx.require(PluginFs), this.ctx.fs)
  assert.throws(() => this.ctx.require(Fs), {code:'CONTEXT_CAPABILITY_ACCESS_DENIED'})
  views.set(this.ctx.pluginInfo.nodeAddress.definition.exportName, await this.ctx.fs())
 }
}
class First extends Owner {}
class Second extends Owner {}
for (const type of [First,Second]) {
 Plugin()(type)
 __setPluginDefinition(type,{abiVersion:PLUGIN_LOWERING_ABI_VERSION,kind:'plugin',definition:{entry:{kind:'package-root',packageName:'independent-service-consumer'},exportName:type.name}})
}
const service = fs({backend:InMemory})
const first = await createHost({plugins:[First,Second],services:[service]})
const second = await createHost({plugins:[],services:[service]})
let owned
try {
 for (const type of [First,Second]) await first.startNode({definition:{entry:{kind:'package-root',packageName:'independent-service-consumer'},exportName:type.name},variant:'default'})
 owned = views.get('First')
 await writeFileAtomic(owned,'document','OWNER-A')
 assert.equal(await owned.readFile('document','utf8'),'OWNER-A')
 await assert.rejects(views.get('Second').readFile('document'),{code:'ENOENT'})
 await assert.rejects((await second.ctx.require(Fs).directory('isolated')).readFile('document'),{code:'ENOENT'})
 await assert.rejects(first.ctx.require(Fs).directory('memory',{durable:true}),{code:'ENOTSUP'})
} finally { await first.close();await second.close() }
await assert.rejects(owned.readFile('document'),{code:'EBADF'})
const prefix = new URL('./native-files/',import.meta.url).pathname
let reads=0,writes=0
const shortened = {...nativeFs,promises:{...nativeFs.promises,async open(...args){
 const handle=await nativeFs.promises.open(...args)
 const read=handle.read.bind(handle),write=handle.write.bind(handle)
 handle.read=(buffer,offset,length,position)=>{reads++;return read(buffer,offset,Math.min(length,2),position)}
 handle.write=(buffer,offset,length,position)=>{writes++;return write(buffer,offset,Math.min(length,2),position)}
 return handle
}}}
let node = await createHost({plugins:[],services:[fs({backend:Passthrough,fs:shortened,prefix})]})
try {
 const io=await node.ctx.require(Fs).directory('documents',{durable:true,writable:true})
 await writeFileAtomic(io,'value','NEW-CONTENT')
 assert.equal(await nativeFs.promises.readFile(prefix+'/documents/value','utf8'),'NEW-CONTENT')
 assert.equal(await io.readFile('value','utf8'),'NEW-CONTENT')
 const handle=await io.open('value','r+')
 try {await handle.write(Uint8Array.of(88,89),0,2,3)} finally {await handle.close()}
 assert.equal(await io.readFile('value','utf8'),'NEWXYONTENT')
 await io.writeFile('value','')
 assert.equal(await nativeFs.promises.readFile(prefix+'/documents/value','utf8'),'')
 await io.writeFile('binary',Uint8Array.of(0,1,255))
 assert.deepEqual(Array.from(await io.readFile('binary')),[0,1,255])
 assert.ok(reads>1 && writes>1)
} finally {await node.close()}
node=await createHost({plugins:[],services:[fs({backend:Passthrough,fs:nativeFs,prefix,readOnly:true})]})
try {
 const io=await node.ctx.require(Fs).directory('documents')
 await assert.rejects(io.writeFile('binary','CHANGED'),{code:'EROFS'})
 await assert.rejects(io.readFile('missing'),{code:'ENOENT'})
 assert.deepEqual(Array.from(await io.readFile('binary')),[0,1,255])
} finally {await node.close()}
let created=false
assert.throws(()=>fs({backend:{...InMemory,create(){created=true;throw new Error('external create')}}}),TypeError)
assert.equal(created,false)
hooks.deregister()
console.log('ISOLATED_FS_OK')
`

const consumer = `
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
const loads = []
const hooks = registerHooks({ load(url, context, next) { loads.push(url); return next(url, context) } })
const { Vault, vault } = await import('@pluxel/services/vault')
assert.equal(loads.some(url => /age-encryption/.test(url)), false, 'token import must not evaluate encryption backend')
const { Fs, fs, InMemory } = await import('@pluxel/services/fs')
const { Commands, commands } = await import('@pluxel/services/commands')
const { createHost } = await import('@pluxel/host')
const { NodeModules, nodeModules } = await import('@pluxel/services/node')
const { Workers, workers, defineWorkerTask } = await import('@pluxel/services/workers')
const { createCoreContextHost, defineContextCapability, installOwnerViewCapability } = await import('@pluxel/core/host')
const { ContextCapabilityMissingError } = await import('@pluxel/core')
const ownerToken = defineContextCapability('consumer.owner', { access: 'all' })
const core = createCoreContextHost({ capabilities: [installOwnerViewCapability(ownerToken, { createRoot: () => ({}), createView: (_, owner) => owner.name })] })
const coreRoot = core.createRoot()
assert.equal(core.createScope(coreRoot, 'isolated').require(ownerToken), 'isolated')
const storage = fs({ backend: InMemory })
const first = await createHost({ plugins: [], services: [vault(), storage, commands()] })
const second = await createHost({ plugins: [], services: [storage] })
try {
 assert.equal(first.ctx.require(Vault), first.ctx.vault)
 assert.deepEqual(first.ctx.require(Commands).list(), [])
 assert.equal(second.ctx.vault, undefined)
 assert.throws(() => second.ctx.require(Vault), ContextCapabilityMissingError)
 assert.equal('database' in first.ctx, false)
 assert.equal('database' in second.ctx, false)
 assert.equal(loads.some(url => ${UNSELECTED_BACKEND_LOAD_PATTERN}.test(url)), false, 'unselected logging, Management and Workbench backends must stay unloaded')
 assert.equal(loads.some(url => /age-encryption/.test(url)), true, 'prepare loads the explicitly selected backend')
 assert.equal(loads.some(url => /(?:@pluxel\\/runtime|\\/pg\\/|pglite)/.test(url)), false)
} finally {
 const close = first.close()
 assert.equal(first.close(), close)
 await close
 await second.close()
 hooks.deregister()
}
await assert.rejects(() => createHost({ plugins: [], services: [workers()] }), /requires unprovided capability/)
const artifacts = new URL('./artifacts/', import.meta.url)
await mkdir(artifacts)
await writeFile(new URL('node-installed.mjs', artifacts), 'export default value => value * 2')
const task = Reflect.apply(defineWorkerTask, undefined, [import.meta.url, './task.ts', 'node-installed'])
const workerHost = await createHost({ plugins: [], services: [workers({ maxThreads: 1 }), nodeModules({ root: fileURLToPath(artifacts) })] })
try {
 assert.equal('attachSourceBinder' in workerHost.ctx.require(NodeModules), false)
 assert.equal(await workerHost.ctx.require(Workers).run(task, 21), 42)
}
finally { await workerHost.close() }
console.log('ISOLATED_SERVICES_OK')
`
const typeConsumer = `
import { standardServices } from '@pluxel/services'
const baseServices = standardServices({ fs: { backend: InMemory } })
void baseServices
import { createHost } from '@pluxel/host'
import { BasePlugin, type Context } from '@pluxel/core'
import { Fs, PluginFs, fs, InMemory, Passthrough, type FsPromises, type FsServiceConfig } from '@pluxel/services/fs'
import { IndexedDB } from '@pluxel/services/fs/browser'
import * as nativeFs from 'node:fs'
const nativeConfig = { backend: Passthrough, fs: nativeFs, prefix: '/data', readOnly: true } satisfies FsServiceConfig
const browserConfig = { backend: IndexedDB, storeName: 'profile', readOnly: true } satisfies FsServiceConfig
// @ts-expect-error Passthrough requires its native fs and prefix options.
const missingNativeConfig: FsServiceConfig = { backend: Passthrough }
void nativeConfig; void browserConfig; void missingNativeConfig
import { Vault, vault, type VaultStorageApi } from '@pluxel/services/vault'
import { nodeModules, NodeModules } from '@pluxel/services/node'
import { workers, Workers, defineWorkerTask } from '@pluxel/services/workers'
import { Commands, commands, type CommandsService } from '@pluxel/services/commands'
const storage = fs({ backend: InMemory })
const first = await createHost({ plugins: [], services: [storage, vault(), commands()] })
const second = await createHost({ plugins: [], services: [storage] })
const required: VaultStorageApi = first.ctx.vault

const commandCatalog: CommandsService = first.ctx.commands
// @ts-expect-error Knowing the service type does not install Commands.
const missingCommands: CommandsService = second.ctx.commands
// @ts-expect-error Ambient declarations do not install Vault into every Host.
const absent: VaultStorageApi = second.ctx.vault
class Consumer extends BasePlugin {
 init() {
  const optional: VaultStorageApi | undefined = this.ctx.vault
  const owned: VaultStorageApi = this.ctx.require(Vault)
  const ownerIo: Promise<FsPromises> = this.ctx.require(PluginFs)({ writable: true })
  void ownerIo
  // @ts-expect-error Root authorities cannot be required on an owner Context.
  this.ctx.require(Fs)
  void optional; void owned
 }
}
function ambient(ctx: Context): VaultStorageApi | undefined { return ctx.vault }
const workerHost = await createHost({ plugins: [], services: [nodeModules({ root: '/artifacts' }), workers()] })
const result: number = await workerHost.ctx.require(Workers).run(defineWorkerTask<number, number>(import.meta.url, './task.ts'), 21)
// @ts-expect-error Plugin-visible Node views have no development source binding authority.
workerHost.ctx.require(NodeModules).attachSourceBinder(() => {})
await workerHost.close()
void result; void required; void absent; void Consumer; void ambient; void commandCatalog; void missingCommands
await first.close(); await second.close()
`

const optionalTypeConsumer = `
import { createTestHost, type TestHost } from '@pluxel/test'
const isolatedTestHost: TestHost = await createTestHost()
await isolatedTestHost.dispose()
const typedWorkbenchTestHost: TestHost<true> = await createTestHost({ workbench: true, services: baseServices })
void typedWorkbenchTestHost.workbench.open
await typedWorkbenchTestHost.dispose()
import { Workbench, workbench } from '@pluxel/workbench'
import { workbenchService } from '@pluxel/workbench/service'
import { requireWorkbench, createWorkbenchArtifactHandler } from '@pluxel/workbench/server'
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import type { WorkbenchSessionApi } from '@pluxel/workbench/client'
import type * as ConsoleContracts from '@pluxel/host-vite/console'
import { host as viteHost } from '@pluxel/host-vite'
import { servicesPreset } from '@pluxel/services/preset'
import { vitePreset, serviceSingletons } from '@pluxel/services/vite'
import { elysiaDevelopment } from '@pluxel/services/elysia/vite'
import { nodeArtifacts } from '@pluxel/services/node/vite'
import { workbenchArtifacts } from '@pluxel/workbench/vite'
import { workbenchHttp } from '@pluxel/workbench/http'
import { createWorkbenchShellHandler } from '@pluxel/workbench/shell'
const uiHost = await createHost({ plugins: [], services: [workbenchService()] })
const definition = workbench.define({ guide: workbench.content({
  document: workbench.markdown(import.meta.url, './guide.md', { refresh: workbench.action({ label: 'Refresh' }) }),
  placement: workbench.tab({ label: 'Guide' }),
}) })
class UiConsumer extends BasePlugin { init() {
  this.ctx.require(Workbench).publish(definition, { guide: () => ({ actions: { refresh: () => {} } }) })
} }
const rootUi = requireWorkbench(uiHost.ctx)
const serveUi = createWorkbenchArtifactHandler(uiHost.ctx)
const development = [serviceSingletons(), viteHost({ entry: './app.ts' }), elysiaDevelopment(), nodeArtifacts(), workbenchArtifacts()]
const officialDevelopment = vitePreset({ entry: './app.ts', devConsole: true })
void [servicesPreset, officialDevelopment]
void [UiConsumer, rootUi, serveUi, development, workbench, createWorkbenchRenderer, workbenchHttp, createWorkbenchShellHandler]
`

const optionalConsumer = `
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
const loads = []
const hook = registerHooks({ load(url, context, next) { loads.push(url); return next(url, context) } })
const { createTestHost } = await import('@pluxel/test')
const emptyTestHost = await createTestHost()
assert.equal(emptyTestHost.workbench, undefined)
await emptyTestHost.dispose()
assert.equal(loads.some(url => /elysia/.test(url)), false, 'empty test host must not load HTTP')
assert.equal(loads.some(url => ${UNSELECTED_BACKEND_LOAD_PATTERN}.test(url)), false, 'unselected logging, Management and Workbench backends must stay unloaded')
const { createHost } = await import('@pluxel/host')
const { resolveContextCapability } = await import('@pluxel/core/host')
const { Workbench } = await import('@pluxel/workbench')
const { workbenchService } = await import('@pluxel/workbench/service')
const { requireWorkbench } = await import('@pluxel/workbench/server')
const { workbenchHttp } = await import('@pluxel/workbench/http')
const { elysia } = await import('@pluxel/services/elysia')
const { ElysiaRuntime } = await import('@pluxel/services/internal')
const { fs, InMemory } = await import('@pluxel/services/fs')
const { management } = await import('@pluxel/services/management/service')
const { managementAccess } = await import('@pluxel/services/management/access')
const { managementHttp } = await import('@pluxel/services/management/http')
const { createWorkbenchArtifactHandler, WorkbenchHost } = await import('@pluxel/workbench/server')
const transport = managementHttp({ bindings: (ctx) => ({ createWorkbench: (principal, invalidate) => requireWorkbench(ctx).createSession(principal, invalidate), artifacts: createWorkbenchArtifactHandler(ctx) }) })
const host = await createHost({ plugins: [], services: [elysia(), fs({ backend: InMemory }), management({ workbench: true }), managementAccess(), workbenchService(), { ...transport, requires: { ...transport.requires, workbench: WorkbenchHost } }, workbenchHttp({ uiBasePath: '/admin' })] })
const server = resolveContextCapability(host.ctx, ElysiaRuntime)
const page = await server.fetch(new Request('http://host.test/admin', { headers: { accept: 'text/html' } }))
assert.equal(page.status, 200)
const html = await page.text()
const entry = /<script[^>]* type="module"[^>]* src="([^"]+)"/.exec(html)?.[1]
assert.ok(entry)
const asset = await server.fetch(new Request('http://host.test' + entry))
assert.equal(asset.status, 200)
assert.ok((await asset.text()).length > 0)
assert.equal((await server.fetch(new Request('http://host.test/api/missing'))).status, 404)
assert.equal(host.ctx.workbench, undefined)
assert.throws(() => host.ctx.require(Workbench), { code: 'CONTEXT_CAPABILITY_ACCESS_DENIED' })
assert.equal(requireWorkbench(host.ctx).registry.revision, 0)
await host.close()
assert.equal(loads.some(url => /@pluxel[+/]runtime|pglite|\\/pg\\//.test(url)), false)
hook.deregister()
const workbenchTestHost = await createTestHost({ workbench: true, services: [elysia(), fs({ backend: InMemory })] })
assert.equal(typeof workbenchTestHost.workbench.open, 'function')
await workbenchTestHost.dispose()
console.log('ISOLATED_WORKBENCH_OK')
`

const bareConsoleConsumer = `
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
const hook = registerHooks({ load(url, context, next) {
 if (/@pluxel[+/](?:services|workbench)|capnweb/.test(url)) {
  throw new Error('Bare development console loaded an optional service: ' + url)
 }
 return next(url, context)
} })
const { createHost } = await import('@pluxel/host')
const { createDevConsoleScope } = await import('@pluxel/host-vite/internal')
const host = await createHost({ plugins: [] })
const scope = createDevConsoleScope({ id: 'installed-services', ctx: host.ctx })
try {
 assert.equal(scope.dev.ctx, host.ctx)
 assert.equal(typeof scope.dev.ctx.logger.info, 'function')
 assert.deepEqual(await scope.dev.plugins.list(), [])
 const missing = { definition: { entry: { kind: 'package-root', packageName: '@test/missing' }, exportName: 'Missing' }, variant: 'default' }
 assert.equal((await scope.dev.config.get(missing)).ok, false)
} finally {
 await scope.dispose()
 await host.close()
 hook.deregister()
}
console.log('ISOLATED_BARE_CONSOLE_OK')
`

const headlessManagementConsumer = `
import { management } from '@pluxel/services/management/service'
import { managementHttp } from '@pluxel/services/management/http'
import { managementAccess } from '@pluxel/services/management/access'
import * as managementSession from '@pluxel/services/management/session'
import { createHost as createManagementHost } from '@pluxel/host'
import { standardServices as managementServices } from '@pluxel/services'
import { InMemory as ManagementMemory } from '@pluxel/services/fs'
const headlessHost = await createManagementHost({ plugins: [], services: [
 ...managementServices({ fs: { backend: ManagementMemory } }), managementAccess(), management(), managementHttp(),
] })
await headlessHost.close()
void [management, managementHttp, managementAccess, managementSession]
console.log('ISOLATED_MANAGEMENT_OK')
`

const headlessManagementTypes = `
import type { RuntimeSessionRoot, RuntimeSessionClient } from '@pluxel/services/management/session'
export type HeadlessSession = RuntimeSessionRoot
export type HeadlessClient = RuntimeSessionClient
`

const standardServicesConsumer = `
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
const loads = []
const hook = registerHooks({ load(url, context, next) { loads.push(url); return next(url, context) } })
const { createHost } = await import('@pluxel/host')
const { standardServices } = await import('@pluxel/services')
const { InMemory } = await import('@pluxel/services/fs')
const { ElysiaRuntime } = await import('@pluxel/services/internal')
const standardHost = await createHost({ plugins: [], services: standardServices({ fs: { backend: InMemory } }) })
try {
 const response = await standardHost.ctx.require(ElysiaRuntime).fetch(new Request('http://local.test/missing'))
 assert.equal(response.status, 404)
 await response.body?.cancel()
 assert.equal(loads.some(url => ${UNSELECTED_BACKEND_LOAD_PATTERN}.test(url)), false, 'unselected logging, Management and Workbench backends must stay unloaded')
} finally { await standardHost.close(); hook.deregister() }
console.log('ISOLATED_STANDARD_SERVICES_OK')
`

const nodeTestConsumer = `
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { writeFile, access } from 'node:fs/promises'
const hook = registerHooks({ load(url, context, next) {
 if (/@pluxel[+/]host-vite/.test(url)) throw new Error('Node test compiler loaded development host: ' + url)
 return next(url, context)
} })
const { createTestHost } = await import('@pluxel/test')
const { nodeModules, defineNodeModule } = await import('@pluxel/services/node')
const { workers, defineWorkerTask } = await import('@pluxel/services/workers')
await writeFile(new URL('./test-task.ts', import.meta.url), 'export default (value: number): number => value * 2')
let ctx
let artifact
const host = await createTestHost({ services: [nodeModules(), workers(), { name: 'capture test owner', capabilities: [], prepare(input) { ctx = input.ctx } }] })
try {
 const task = defineWorkerTask(import.meta.url, './test-task.ts')
 assert.equal(await ctx.workers.run(task, 21), 42)
 await ctx.nodeModules.use(defineNodeModule(import.meta.url, './test-task.ts'), url => { artifact = url })
 await access(artifact)
} finally { await host.dispose(); hook.deregister() }
await assert.rejects(access(artifact), { code: 'ENOENT' })
console.log('ISOLATED_NODE_TEST_OK')
`
