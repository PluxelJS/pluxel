import { mkdtemp, mkdir, writeFile, readFile, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import type { UserConfig } from 'vite-plus/pack'
import { pluxel } from '@pluxel/rolldown'

describe('tsdown application plugin', () => {
	it('preserves ordinary plugin order and native output preferences while installing the freezer once', async () => {
		const before = { name: 'external-before' }
		const after = { name: 'external-after' }
		const plugin = pluxel({ variant: 'headless' })
		const config: UserConfig = {
			entry: './app.ts',
			outDir: 'release',
			minify: false,
			sourcemap: 'hidden',
			clean: false,
			plugins: [before, Promise.resolve([plugin]), after],
			outputOptions: { sourcemapExcludeSources: true },
		}
		const result = (await plugin.tsdownConfig!(config, {})) as UserConfig
		expect(result).toMatchObject({
			minify: false,
			sourcemap: 'hidden',
			clean: false,
			outputOptions: { sourcemapExcludeSources: true },
		})
		expect(result.outDir).toMatch(/release$/)
		const plugins = (await result.plugins) as unknown[]
		expect(plugins[0]).toBe(before)
		expect(plugins.at(-1)).toBe(after)
		expect(plugins).not.toContain(plugin)
		const generated = plugins[1] as { name: string }[]
		expect(
			generated.filter((entry) => entry.name === 'pluxel-static-application-entry'),
		).toHaveLength(1)
	})

	it('rejects ambiguous application entries before running build hooks', async () => {
		expect(() => Reflect.apply(pluxel, undefined, [{ launcher: 'node' }])).toThrow(
			'unsupported launcher',
		)
		const plugin = pluxel()
		await expect(plugin.tsdownConfig!({ entry: ['one.ts', 'two.ts'] }, {})).rejects.toThrow(
			'exactly one application module',
		)
		await expect(
			plugin.tsdownConfig!({ entry: './app.ts', platform: 'browser' }, {}),
		).rejects.toThrow('node platform')
		await expect(plugin.tsdownConfig!({ entry: './app.ts', format: 'cjs' }, {})).rejects.toThrow(
			'esm format',
		)
	})

	it('captures managed driver selection through the public application plugin', async () => {
		const drivers: ('pglite' | 'postgres')[] = []
		const plugin = pluxel({ variant: 'headless', managedDatabaseDrivers: drivers, lint: false })
		drivers.push('pglite')
		const result = (await plugin.tsdownConfig!(
			{ entry: './app.ts', plugins: [plugin] },
			{},
		)) as UserConfig
		const [generated] = (await result.plugins) as Array<
			Array<{
				name: string
				resolveId?: (
					this: object,
					id: string,
					importer: string,
					options: object,
				) => Promise<unknown>
			}>
		>
		const externals = generated!.find((entry) => entry?.name === 'pluxel:nf3-externals')!
		for (const driver of ['pglite', 'postgres']) {
			await expect(
				externals.resolveId!.call({}, `#pluxel/database-driver/${driver}`, '/app/app.ts', {}),
			).resolves.toBe(`\0pluxel:omitted-managed-database:${driver}`)
		}
	})

	it('rejects invalid managed driver selections and modules-only misuse before building', () => {
		for (const managedDatabaseDrivers of [null, 'pglite']) {
			expect(() => Reflect.apply(pluxel, undefined, [{ managedDatabaseDrivers }])).toThrow(
				'managedDatabaseDrivers must be an array',
			)
		}
		expect(() =>
			Reflect.apply(pluxel, undefined, [{ managedDatabaseDrivers: ['sqlite'] }]),
		).toThrow('managedDatabaseDrivers[0] must be "pglite" or "postgres"')
		const moduleSelections: Array<readonly string[] | undefined> = [[], undefined]
		for (const managedDatabaseDrivers of moduleSelections) {
			expect(() =>
				Reflect.apply(pluxel, undefined, [{ delivery: 'modules', managedDatabaseDrivers }]),
			).toThrow('modules includes standalone-only managedDatabaseDrivers')
		}
	})
})

it('freezes a Host-only application without evaluating its async factory and runs fresh configuration outside the workspace', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-host-application-'))
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host'])
			await symlink(
				fileURLToPath(new URL(`../../${name}/`, import.meta.url)),
				join(root, 'node_modules/@pluxel', name),
				'dir',
			)
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'host-only', type: 'module' }),
		)
		await writeFile(
			join(root, 'app.ts'),
			`
import { defineHostApplication, defineHostService } from '@pluxel/host';
import { defineContextCapability, installRootCapability } from '@pluxel/core/host';
const Selected = defineContextCapability('Selected');
export default defineHostApplication(async ({env}) => {
  if (env.APPLICATION_STAGE !== 'run') throw new Error('FACTORY_EXECUTED_DURING_BUILD');
  return { plugins: [], services: [defineHostService({name:'Selected',capabilities:[installRootCapability(Selected,{create:()=>env.APPLICATION_VALUE})],prepare({effects}) { process.stdout.write('SERVICE_READY:'+env.APPLICATION_VALUE+'\\n'); effects.defer(()=>{process.stdout.write('SERVICE_CLOSED\\n')}) }})] };
});`,
		)
		const script = join(root, 'build.mts')
		await writeFile(
			script,
			`
import { build } from ${JSON.stringify(import.meta.resolve('vite-plus/pack'))};
import { pluxel } from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)};
await build({cwd:${JSON.stringify(root)},entry:'app.ts',minify:false,plugins:[pluxel({variant:'headless',lint:false})],config:false});`,
		)
		await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), script], {
			timeout: 30000,
			maxBuffer: 4 * 1024 * 1024,
		})
		const bundled = await readFile(join(root, 'dist/app.mjs'), 'utf8')
		expect(bundled).not.toMatch(
			/@pluxel\/runtime|NodeElysiaApplicationCarrier|PGlite|createPostgresDatabaseAdapter/,
		)
		await rm(join(root, 'node_modules'), { recursive: true })
		const child = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
const application = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/app.mjs')).href)});
if ('fetch' in application || 'address' in application) throw new Error('UNSELECTED_HTTP');
await application.stop();`,
			],
			{
				env: { ...process.env, APPLICATION_STAGE: 'run', APPLICATION_VALUE: 'fresh' },
				timeout: 10000,
			},
		)
		expect(child.stdout).toContain('SERVICE_READY:fresh')
		expect(child.stdout).toContain('SERVICE_CLOSED')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 60000)

it('rejects reserved standalone exports through direct, alias and barrel exports before application startup', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-reserved-application-'))
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host'])
			await symlink(
				fileURLToPath(new URL(`../../${name}/`, import.meta.url)),
				join(root, 'node_modules/@pluxel', name),
				'dir',
			)
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'reserved-application', type: 'module' }),
		)
		await writeFile(
			join(root, 'exports.ts'),
			"export const startValue = 'application-start'; export const stopValue = 'application-stop';",
		)
		await writeFile(join(root, 'barrel.ts'), "export { stopValue as stop } from './exports';")
		await writeFile(
			join(root, 'app.ts'),
			`
import { defineHostApplication } from '@pluxel/host';
export const host = 'application-host';
const applicationContext = 'application-context';
export { applicationContext as ctx };
export { startValue as start } from './exports';
export * from './barrel';
export default defineHostApplication(() => {
 process.stdout.write('FACTORY_EXECUTED\\n');
 return {
  plugins: [],
  prepare() { process.stdout.write('PREPARE_EXECUTED\\n'); },
  launch() { process.stdout.write('LAUNCH_EXECUTED\\n'); },
 };
});`,
		)
		const script = join(root, 'build.mts')
		await writeFile(
			script,
			`
import { build } from ${JSON.stringify(import.meta.resolve('vite-plus/pack'))};
import { pluxel } from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)};
await build({cwd:${JSON.stringify(root)},entry:'app.ts',plugins:[pluxel({variant:'headless',lint:false})],config:false});`,
		)
		const built = await promisify(execFile)(
			process.execPath,
			['--import', import.meta.resolve('tsx'), script],
			{ timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
		)
		expect(built.stdout).not.toMatch(/FACTORY_EXECUTED|PREPARE_EXECUTED|LAUNCH_EXECUTED/)
		await rm(join(root, 'node_modules'), { recursive: true })
		// Missing deployment metadata also proves the namespace check precedes artifact IO.
		await rm(join(root, 'dist/pluxel-deployment.json'))
		const child = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict';
await assert.rejects(import(${JSON.stringify(pathToFileURL(join(root, 'dist/app.mjs')).href)}), {
 name: 'TypeError',
 message: '[pluxel:application] standalone application exports reserved entry names: host, ctx, start, stop',
});
console.log('RESERVED_EXPORTS_REJECTED');`,
			],
			{ timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
		)
		expect(child.stdout.trim()).toBe('RESERVED_EXPORTS_REJECTED')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 60000)

it('delivers an application-owned fetch export after launch without opening a listener', async () => {
	const temporary = await mkdtemp(join(tmpdir(), 'pluxel-fetch-application-'))
	const root = join(temporary, 'source')
	const deployed = join(temporary, 'delivery')
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host', 'services'])
			await symlink(
				fileURLToPath(new URL(`../../${name}/`, import.meta.url)),
				join(root, 'node_modules/@pluxel', name),
				'dir',
			)
		await symlink(
			fileURLToPath(new URL('../../services/node_modules/elysia/', import.meta.url)),
			join(root, 'node_modules/elysia'),
			'dir',
		)
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'fetch-application', type: 'module' }),
		)
		await writeFile(
			join(root, 'app.ts'),
			`
import { BasePlugin, Plugin } from '@pluxel/core';
import { defineHostApplication } from '@pluxel/host';
import { elysia, createElysiaHandler } from '@pluxel/services/elysia';
import { t } from 'elysia';
@Plugin()
class Echo extends BasePlugin {
 protected init() {
  const router = this.ctx.elysia;
  if (!router) throw new Error('Elysia service is not installed');
  router.get('/echo', {query:t.Object({message:t.String()})}, ({query}) => query.message);
 }
}
let handler: ReturnType<typeof createElysiaHandler> | undefined;
export function fetch(request: Request): Promise<Response> {
 if (!handler) throw new Error('Application has not launched');
 return handler(request);
}
export const endpointName = 'echo';
export default defineHostApplication(() => ({
 plugins:[Echo], services:[elysia()], policy:{autoStart:[Echo]},
 launch({host}) { handler=createElysiaHandler(host); }
}));`,
		)
		const script = join(root, 'build.mts')
		await writeFile(
			script,
			`
import { build } from ${JSON.stringify(import.meta.resolve('vite-plus/pack'))};
import { pluxel } from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)};
await build({cwd:${JSON.stringify(root)},entry:'app.ts',plugins:[pluxel({variant:'headless',managedDatabaseDrivers:[],lint:false})],config:false});`,
		)
		await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), script], {
			timeout: 30000,
			maxBuffer: 4 * 1024 * 1024,
		})
		await rename(join(root, 'dist'), deployed)
		await rm(root, { recursive: true })
		const child = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict';
const application=await import(${JSON.stringify(pathToFileURL(join(deployed, 'app.mjs')).href)});
try {
 assert.equal(application.endpointName,'echo');
 assert.equal('address' in application,false);
 const response=await application.fetch(new Request('http://application.test/echo?message=APPLICATION_FETCH_OK'));
 assert.equal(response.status,200);
 assert.equal(await response.text(),'APPLICATION_FETCH_OK');
 const invalid=await application.fetch(new Request('http://application.test/echo'));
 assert.equal(invalid.status,422);
 await invalid.text();
} finally { await application.stop(); }
assert.equal((await application.fetch(new Request('http://application.test/echo?message=closed'))).status,503);
console.log('APPLICATION_FETCH_CLOSED');`,
			],
			{ cwd: deployed, timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
		)
		expect(child.stdout).toContain('APPLICATION_FETCH_CLOSED')
	} finally {
		await rm(temporary, { recursive: true, force: true })
	}
}, 60000)
