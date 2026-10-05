import { execFile } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import {
	chmod,
	mkdtemp,
	mkdir,
	readFile,
	readdir,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { pluxel } from '../src/application'
import { createModulesApplicationConfig } from '../src/cli/modules-application'
import {
	createDistributionStatement,
	createDssePreAuthenticationEncoding,
	createDistributionDsseEnvelope,
	serializeDistributionDsseEnvelope,
	fingerprintDistributionKey,
	verifyDistribution,
	DISTRIBUTION_DSSE_PAYLOAD_TYPE,
	DISTRIBUTION_ENVELOPE_FILE,
	createDistributionManifest,
} from '../src/distribution'

async function setOutputPermissions(directory: string, writable: boolean): Promise<void> {
	await chmod(directory, writable ? 0o755 : 0o555)
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = resolve(directory, entry.name)
		if (entry.isDirectory()) await setOutputPermissions(path, writable)
		else if (entry.isFile()) await chmod(path, writable ? 0o644 : 0o444)
		else throw new TypeError(`unexpected output file: ${path}`)
	}
}

it('rejects standalone-only and removed options in JavaScript modules calls', () => {
	for (const [options, message] of [
		[{ delivery: 'modules', launcher: 'node' }, 'standalone-only launcher'],
		[{ delivery: 'modules', residualDependencies: [] }, 'standalone-only residualDependencies'],
		[{ delivery: 'modules', sourceFrameworks: true }, 'unsupported sourceFrameworks'],
		[{ delivery: 'modules', variant: 'dynamic' }, 'variant must be'],
		[{ delivery: 'modules', lint: 'false' }, 'lint must be'],
	] as const)
		expect(() => Reflect.apply(pluxel, undefined, [options])).toThrow(message)
})

it('rejects public export collisions, reserved application entry and sources outside the package', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-modules-exports-'))
	try {
		for (const [exports, message] of [
			[
				{ '.': './src/root.ts', './index': './src/other.ts' },
				'conflicts with output entry index.mjs',
			],
			[
				{ '.': './src/root.ts', './index': './src/root.ts' },
				'conflicts with output entry index.mjs',
			],
			[{ './app': './src/public.ts' }, './app is reserved'],
			[{ './public': './outside/../../other.ts' }, 'public source export escapes its package'],
			[{ './public': 'src/public.ts' }, 'public source export must be package-relative'],
		] as const) {
			await writeFile(
				resolve(root, 'package.json'),
				JSON.stringify({ name: '@fixture/exports', exports }),
			)
			await expect(
				createModulesApplicationConfig({
					entry: 'src/app.ts',
					cwd: root,
					variant: 'headless',
					lint: false,
				}),
			).rejects.toThrow(message)
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('uses package source conditions and excludes declaration files and built JavaScript defaults', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-modules-conditions-'))
	try {
		await writeFile(
			resolve(root, 'package.json'),
			JSON.stringify({
				name: '@fixture/conditions',
				exports: {
					'.': { '@pluxel/hmr': './src/root.js', default: './dist/index.mjs' },
					'./source': { '@pluxel/source': { import: './src/source.js' } },
					'./development': { development: './src/development.js' },
					'./import': { import: './src/import.ts' },
					'./default': { default: './src/default.mts' },
					'./__proto__': './src/prototype.ts',
					'./types': { '@pluxel/hmr': './src/types.d.ts', default: './src/types.d.mts' },
					'./built': { default: './dist/built.mjs' },
				},
			}),
		)
		const config = await createModulesApplicationConfig({
			entry: 'src/app.ts',
			cwd: root,
			variant: 'headless',
			lint: false,
		})
		const { app: _app, ...publicEntries } = config.entry as Record<string, string>
		expect(publicEntries).toEqual({
			index: resolve(root, 'src/root.js'),
			source: resolve(root, 'src/source.js'),
			development: resolve(root, 'src/development.js'),
			import: resolve(root, 'src/import.ts'),
			default: resolve(root, 'src/default.mts'),
			['__proto__']: resolve(root, 'src/prototype.ts'),
		})
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('rejects malformed package manifest fields before constructing output entries', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-modules-manifest-'))
	try {
		const cases: readonly (readonly [unknown, string])[] = [
			[null, 'Invalid package manifest'],
			[{ exports: './src/root.ts' }, 'exports must be an explicit subpath map'],
			[{ exports: [] }, 'exports must be an explicit subpath map'],
			[{ exports: { import: './src/root.ts' } }, 'exports must be an explicit subpath map'],
			[{ exports: null }, 'exports must be an explicit subpath map'],
			[{ name: 42 }, 'name must be a non-empty string'],
			[{ dependencies: [] }, 'dependencies must map package names'],
			[{ optionalDependencies: { example: false } }, 'optionalDependencies must map package names'],
			[{ peerDependenciesMeta: { example: { optional: 'yes' } } }, 'peerDependenciesMeta must map'],
			[{ pluxel: 'artifacts' }, 'pluxel must be an object'],
		]
		for (const [manifest, message] of cases) {
			await writeFile(resolve(root, 'package.json'), JSON.stringify(manifest))
			await expect(
				createModulesApplicationConfig({
					entry: 'src/app.ts',
					cwd: root,
					variant: 'headless',
					lint: false,
				}),
			).rejects.toThrow(message)
		}
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('preserves public and private identities, named product, minified artifacts and signed relocation for native and production Vite', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-modules-contract-'))
	const deployed = resolve(root, 'relocated')
	try {
		await mkdir(resolve(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host', 'host-vite', 'services', 'commands', 'workbench'])
			await symlink(
				fileURLToPath(new URL(`../../${name}`, import.meta.url)),
				resolve(root, 'node_modules/@pluxel', name),
			)
		await mkdir(resolve(root, 'src'))
		await writeFile(
			resolve(root, 'package.json'),
			JSON.stringify({
				name: '@fixture/modules',
				dependencies: { '@pluxel/host': '^1.1.0' },
				version: '1.0.0',
				type: 'module',
				exports: {
					'.': { '@pluxel/hmr': './src/public.ts', default: './dist/index.mjs' },
					'./feature': './src/feature.ts',
					'./__proto__': './src/prototype.ts',
				},
			}),
		)
		const plugin = (name: string) =>
			`import {BasePlugin,Plugin} from '@pluxel/core'; @Plugin() export class ${name} extends BasePlugin {}`
		await writeFile(resolve(root, 'src/public.ts'), plugin('Public'))
		await writeFile(resolve(root, 'src/feature.ts'), plugin('Feature'))
		await writeFile(
			resolve(root, 'src/prototype.ts'),
			`export const value='Prototype public module'`,
		)
		await writeFile(resolve(root, 'src/task.ts'), 'export default (value: number) => value * 2')
		await writeFile(
			resolve(root, 'src/private.ts'),
			`import {BasePlugin,Plugin} from '@pluxel/core'; import {Workers,defineWorkerTask} from '@pluxel/services/workers'; const task=defineWorkerTask<number,number>(import.meta.url,'./task.ts'); @Plugin() export class Private extends BasePlugin {async init(){const value=await this.ctx.require(Workers).run(task,21);if(value!==42)throw new Error('ARTIFACT_NOT_RELOCATED');console.log('MODULES_WORKER_OK')}}`,
		)
		await writeFile(
			resolve(root, 'src/app.ts'),
			`import {defineHostApplication} from '@pluxel/host'; import {pluginNodeAddressOf} from '@pluxel/core'; import {standardServices} from '@pluxel/services'; import {Public} from './public'; import {Feature} from './feature'; import {Private} from './private'; export const product={title:'Modules probe'}; export default defineHostApplication(()=>({plugins:[Public,Feature,Private],services:standardServices({persistence:{mode:'memory'}}),state:{mode:'memory',initial:{autoStart:[pluginNodeAddressOf(Private)]}},prepare({host,startup}){startup.bindings.capture?.(host)}}))`,
		)
		await writeFile(
			resolve(root, 'build.mts'),
			`import {build} from ${JSON.stringify(import.meta.resolve('tsdown'))}; import {pluxel} from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)}; const options={delivery:'modules',variant:'headless',lint:false}; const application=pluxel(options); options.delivery='standalone'; options.variant='workbench'; await build({cwd:${JSON.stringify(root)},entry:'src/app.ts',plugins:[application],config:false});`,
		)
		await promisify(execFile)(
			process.execPath,
			['--import', import.meta.resolve('tsx'), resolve(root, 'build.mts')],
			{ timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
		)
		await rename(resolve(root, 'dist'), deployed)
		await rm(resolve(root, 'src'), { recursive: true })
		await mkdir(resolve(deployed, 'public'))
		await writeFile(
			resolve(deployed, 'public/index.html'),
			'<!doctype html><script src="/main.js"></script><p>Compiled product</p>',
		)
		await writeFile(resolve(deployed, 'public/main.js'), 'console.log("compiled")')
		await createDistributionManifest(deployed)
		const outputPackage = JSON.parse(await readFile(resolve(deployed, 'package.json'), 'utf8'))
		expect(outputPackage.dependencies).toEqual({ '@pluxel/host': '^1.1.0' })
		expect(outputPackage.exports['./feature']).toBe('./feature.mjs')
		expect(outputPackage.exports['./__proto__']).toBe('./__proto__.mjs')
		const manifest = await readFile(resolve(deployed, 'pluxel-distribution.json'))
		expect(JSON.parse(manifest.toString()).producer.kind).toBe('modules-application')
		const { privateKey, publicKey } = generateKeyPairSync('ed25519')
		const statement = createDistributionStatement(manifest, { version: '1.0.0' })
		const sig = sign(
			null,
			createDssePreAuthenticationEncoding(DISTRIBUTION_DSSE_PAYLOAD_TYPE, statement),
			privateKey,
		).toString('base64')
		await writeFile(
			resolve(deployed, DISTRIBUTION_ENVELOPE_FILE),
			serializeDistributionDsseEnvelope(
				createDistributionDsseEnvelope(statement, [
					{ keyid: fingerprintDistributionKey(publicKey), sig },
				]),
			),
		)
		// Vite receives the compiled factory, never the deleted TS source or native bootstrap.
		await writeFile(
			resolve(root, 'vite.config.mjs'),
			`import {vitePreset} from '@pluxel/services/vite'; export default {logLevel:'error',cacheDir:'.vite',plugins:[...vitePreset({entry:'relocated/app.mjs',bindings:{capture:host=>{globalThis.__modulesHost=host}}}),{name:'fixture:modules-server',configureServer(server){globalThis.__modulesServer=server}}]}`,
		)
		await setOutputPermissions(deployed, false)
		const shared = `const {default:assert}=await import('node:assert/strict'); const {pluginDefinitionAddressOf}=await import('@pluxel/core'); const app=await import(${JSON.stringify(pathToFileURL(resolve(deployed, 'app.mjs')).href)}); assert.equal(app.product.title,'Modules probe'); const startup={root:${JSON.stringify(root)},mode:'production',env:{},bindings:{}}; const declared=await app.default(startup); const [pub,feature,local]=declared.plugins; assert.deepEqual(pluginDefinitionAddressOf(pub),{entry:{kind:'package-root',packageName:'@fixture/modules'},exportName:'Public'}); assert.deepEqual(pluginDefinitionAddressOf(feature),{entry:{kind:'package-subpath',packageName:'@fixture/modules',subpath:'./feature'},exportName:'Feature'}); assert.equal(pluginDefinitionAddressOf(local).entry.kind,'source-entry'); assert.equal((await import(${JSON.stringify(pathToFileURL(resolve(deployed, 'index.mjs')).href)})).Public,pub);`
		const native = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`const {runHostApplication}=await import('@pluxel/host'); const host=await runHostApplication(${JSON.stringify(resolve(deployed, 'app.mjs'))},{startup:{root:${JSON.stringify(root)},mode:'production',env:{},bindings:{}},sharedPackages:['@pluxel/services','@pluxel/commands']}); try{` +
					shared +
					`assert.equal((await import(${JSON.stringify(pathToFileURL(resolve(deployed, '__proto__.mjs')).href)})).value,'Prototype public module');assert.equal(host.catalog().entries.length,3)}finally{await host.close()}`,
			],
			{ cwd: root, timeout: 15000 },
		)
		expect(native.stdout).toContain('MODULES_WORKER_OK')
		const listener = createServer()
		await new Promise<void>((ready) => listener.listen(0, '127.0.0.1', ready))
		const port = (listener.address() as { port: number }).port
		await new Promise<void>((closed) => listener.close(() => closed()))
		const vite = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`import assert from 'node:assert/strict'; const {runViteApplication}=await import('@pluxel/host-vite/run'); const session=await runViteApplication({root:${JSON.stringify(root)},configFile:'vite.config.mjs'});try{assert.equal(globalThis.__modulesHost.catalog().entries.length,3);assert.equal((await globalThis.__modulesServer.environments.pluxel.runner.import(${JSON.stringify(resolve(deployed, '__proto__.mjs'))})).value,'Prototype public module');const url='http://127.0.0.1:'+process.env.PLUXEL_HOST_PORT;assert.match(await fetch(url+'/nested/page',{headers:{accept:'text/html'}}).then(r=>r.text()),/Compiled product/);assert.equal((await fetch(url+'/main.js')).status,200);for(const path of ['/@vite/client','/node_modules/x','/__pluxel/dev-console'])assert.equal((await fetch(url+path,{headers:{accept:'text/html'}})).status,404)}finally{await session.close()}`,
			],
			{
				cwd: root,
				env: {
					...process.env,
					NODE_ENV: 'production',
					PLUXEL_HOST_PORT: String(port),
					PLUXEL_HOST_BIND: '127.0.0.1',
				},
				timeout: 15000,
				maxBuffer: 4 * 1024 * 1024,
			},
		)
		expect(vite.stdout).toContain('MODULES_WORKER_OK')
		await expect(verifyDistribution(deployed, [publicKey])).resolves.toMatchObject({
			code: 'VERIFIED',
		})
		await setOutputPermissions(deployed, true)
		await writeFile(
			resolve(deployed, 'app.mjs'),
			(await readFile(resolve(deployed, 'app.mjs'), 'utf8')) + '\n// corrupt\n',
		)
		await expect(
			promisify(execFile)(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`const {runHostApplication}=await import('@pluxel/host'); await runHostApplication(${JSON.stringify(resolve(deployed, 'app.mjs'))},{startup:{root:${JSON.stringify(root)},mode:'production',env:{},bindings:{}}})`,
				],
				{ cwd: root },
			),
		).rejects.toThrow(/modules application digest mismatch/)
	} finally {
		await setOutputPermissions(deployed, true).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== 'ENOENT') throw error
		})
		await rm(root, { recursive: true, force: true })
	}
}, 60000)

it('compiles package-local imports into relocatable modules output', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-modules-imports-'))
	try {
		await mkdir(resolve(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host'])
			await symlink(
				fileURLToPath(new URL(`../../${name}`, import.meta.url)),
				resolve(root, 'node_modules/@pluxel', name),
			)
		await mkdir(resolve(root, 'src'))
		await mkdir(resolve(root, 'node_modules/fixture-value'))
		await writeFile(
			resolve(root, 'node_modules/fixture-value/package.json'),
			JSON.stringify({
				name: 'fixture-value',
				version: '1.0.0',
				type: 'module',
				exports: './index.js',
			}),
		)
		await writeFile(resolve(root, 'node_modules/fixture-value/index.js'), 'export const extra = 1')
		await writeFile(
			resolve(root, 'package.json'),
			JSON.stringify({
				name: '@fixture/imports',
				version: '1.0.0',
				type: 'module',
				imports: { '#value': './src/value.ts', '#external': 'fixture-value' },
				dependencies: { '@pluxel/host': '^1.1.0', 'fixture-value': '1.0.0' },
			}),
		)
		await writeFile(resolve(root, 'src/value.ts'), 'export const value = 42')
		await writeFile(
			resolve(root, 'src/app.ts'),
			"import {defineHostApplication} from '@pluxel/host'; import {value} from '#value'; import {extra} from '#external'; export const product={title:String(value+extra)}; export default defineHostApplication(()=>({plugins:[]}))",
		)
		await writeFile(
			resolve(root, 'build.mts'),
			`import {build} from ${JSON.stringify(import.meta.resolve('tsdown'))}; import {pluxel} from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)}; await build({cwd:${JSON.stringify(root)},entry:'src/app.ts',plugins:[pluxel({delivery:'modules',variant:'headless',lint:false})],config:false});`,
		)
		await promisify(execFile)(
			process.execPath,
			['--import', import.meta.resolve('tsx'), resolve(root, 'build.mts')],
			{ timeout: 30000 },
		)
		await rename(resolve(root, 'dist'), resolve(root, 'relocated'))
		await rm(resolve(root, 'src'), { recursive: true })
		const result = await promisify(execFile)(process.execPath, [
			'--input-type=module',
			'-e',
			`const m = await import(${JSON.stringify(resolve(root, 'relocated/app.mjs'))}); console.log(m.product.title)`,
		])
		expect(result.stdout.trim()).toBe('43')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 40000)
