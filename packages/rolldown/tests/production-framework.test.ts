import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'

const { version: coreVersion } = JSON.parse(
	await readFile(new URL('../../core/package.json', import.meta.url), 'utf8'),
) as { version: string }
const { version: servicesVersion } = JSON.parse(
	await readFile(new URL('../../services/package.json', import.meta.url), 'utf8'),
) as { version: string }

it('relocates a traced native library in the Pluxel namespace without external framework copies', async () => {
	const temporary = await mkdtemp(join(tmpdir(), 'pluxel-standalone-native-library-'))
	const root = join(temporary, 'source')
	const library = join(root, 'library')
	const deployed = join(temporary, 'delivery')
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host'])
			await symlink(
				fileURLToPath(new URL(`../../${name}/`, import.meta.url)),
				join(root, 'node_modules/@pluxel', name),
				'dir',
			)
		await symlink(
			fileURLToPath(new URL('../node_modules/valibot/', import.meta.url)),
			join(root, 'node_modules/valibot'),
			'dir',
		)
		await mkdir(join(library, 'dist'), { recursive: true })
		await symlink(library, join(root, 'node_modules/@pluxel/native-fixture'), 'dir')
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'native-library-app', type: 'module' }),
		)
		await writeFile(
			join(library, 'package.json'),
			JSON.stringify({ name: '@pluxel/native-fixture', version: '1.0.0', main: 'dist/index.cjs' }),
		)
		await writeFile(join(library, 'dist/index.cjs'), "module.exports = require('../binding.cjs')")
		await writeFile(
			join(library, 'binding.cjs'),
			"module.exports = require('node:fs').readFileSync(require('node:path').join(__dirname, 'runtime.asset'), 'utf8')",
		)
		await writeFile(join(library, 'runtime.asset'), 'RESIDUAL_NATIVE_LAYOUT_OK')
		await writeFile(
			join(root, 'app.ts'),
			`import native from '@pluxel/native-fixture';
import {BasePlugin,Plugin} from '@pluxel/core';
import {defineHostApplication} from '@pluxel/host';
import * as v from 'valibot';
@Plugin()
class Probe extends BasePlugin {
 private readonly config = this.configs.use(v.object({answer:v.number()}));
 protected init(){if(this.config.answer!==42) throw new Error('Standalone config was lost'); console.log('STANDALONE_CONFIG_AND_AUTOSTART_OK')}
}
export default defineHostApplication(() => ({
 plugins:[Probe],
 policy:{autoStart:[Probe],startTimeoutMs:12345},
 config:{records:[{owner:Probe,config:{answer:42}}]},
 async prepare({host}) {
  const policy=await host.policy.get();
  if(!policy.ok || policy.effective.startTimeoutMs!==12345) throw new Error('Standalone execution policy was lost');
  if(native!=='RESIDUAL_NATIVE_LAYOUT_OK') throw new Error('Native library layout changed');
  console.log(native);
 }
}))`,
		)
		const buildScript = join(root, 'build.mts')
		await writeFile(
			buildScript,
			`import {build} from ${JSON.stringify(import.meta.resolve('vite-plus/pack'))}; import {pluxel} from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)}; await build({cwd:${JSON.stringify(root)},entry:'app.ts',plugins:[pluxel({delivery:'standalone',variant:'headless',lint:false,residualDependencies:{packages:['@pluxel/native-fixture']}})],config:false})`,
		)
		await promisify(execFile)(
			process.execPath,
			['--import', import.meta.resolve('tsx'), buildScript],
			{ timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
		)
		const manifest = JSON.parse(await readFile(join(root, 'dist/pluxel-deployment.json'), 'utf8'))
		expect(manifest.server.runtimeClosure).toBe('bundled')
		expect(manifest.residualDependencies.packages).toEqual(['@pluxel/native-fixture'])
		await rename(join(root, 'dist'), deployed)
		await rm(root, { recursive: true, force: true })
		const child = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`const app = await import(${JSON.stringify(pathToFileURL(join(deployed, 'app.mjs')).href)}); await app.stop(); console.log('STANDALONE_RESIDUAL_CLOSED')`,
			],
			{ cwd: deployed, timeout: 30000 },
		)
		expect(child.stdout).toContain('RESIDUAL_NATIVE_LAYOUT_OK')
		expect(child.stdout).toContain('STANDALONE_CONFIG_AND_AUTOSTART_OK')
		expect(child.stdout).toContain('STANDALONE_RESIDUAL_CLOSED')
	} finally {
		await rm(temporary, { recursive: true, force: true })
	}
}, 60000)

it('preserves native modules and shared framework identity with installed modules in a fresh Node process', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-production-bridge-'))
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host', 'commands', 'services']) {
			await symlink(
				fileURLToPath(new URL(`../../${name}/`, import.meta.url)),
				join(root, 'node_modules/@pluxel', name),
				'dir',
			)
		}
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'native-modules-probe', version: '1.0.0', type: 'module' }),
		)
		const sources = join(root, 'mutable/entries')
		await mkdir(sources, { recursive: true })
		await mkdir(join(root, 'mutable/node_modules/installed'), { recursive: true })
		await mkdir(join(root, 'mutable/node_modules/@pluxel/core'), { recursive: true })
		await writeFile(
			join(root, 'mutable/node_modules/@pluxel/core/package.json'),
			JSON.stringify({
				name: '@pluxel/core',
				version: coreVersion,
				type: 'module',
				exports: { '.': './wrong.mjs', './toolchain': './wrong.mjs' },
			}),
		)
		await writeFile(
			join(root, 'mutable/node_modules/@pluxel/core/wrong.mjs'),
			'throw new Error("WRONG_CORE_COPY")',
		)
		await mkdir(join(root, 'mutable/node_modules/@pluxel/services'), { recursive: true })
		await writeFile(
			join(root, 'mutable/node_modules/@pluxel/services/package.json'),
			JSON.stringify({
				name: '@pluxel/services',
				version: servicesVersion,
				type: 'module',
				exports: { './commands': './wrong.mjs' },
			}),
		)
		await writeFile(
			join(root, 'mutable/node_modules/@pluxel/services/wrong.mjs'),
			'throw new Error("WRONG_SERVICE_COPY")',
		)
		await writeFile(
			join(root, 'mutable/node_modules/installed/package.json'),
			JSON.stringify({ name: 'installed', type: 'module', exports: './index.mjs' }),
		)
		const address = {
			definition: {
				entry: { kind: 'package-root', packageName: 'installed' },
				exportName: 'Dynamic',
			},
			variant: 'default',
		}
		await writeFile(
			join(root, 'mutable/node_modules/installed/index.mjs'),
			`
import {BasePlugin,Plugin} from '@pluxel/core';
import {__setPluginDefinition} from '@pluxel/core/toolchain';
import {Commands} from '@pluxel/services/commands';
class Dynamic extends BasePlugin { init(){ if (!Array.isArray(this.ctx.require(Commands).list())) throw new Error('MISSING_COMMANDS'); if (Commands !== globalThis.__frameworkCommands) throw new Error('COMMANDS_IDENTITY_MISMATCH'); process.stdout.write('DYNAMIC_STARTED\\n') } }
Plugin()(Dynamic); __setPluginDefinition(Dynamic,{abiVersion:2,kind:'plugin',definition:${JSON.stringify(address.definition)}}); export {Dynamic};
`,
		)
		await writeFile(join(sources, 'installed.mjs'), "export * from 'installed'")
		await writeFile(join(root, 'task.ts'), 'export default (value: number) => value * 2')
		await writeFile(
			join(root, 'app.ts'),
			`import {pluginSource} from '@pluxel/host/sources';
import {Commands} from '@pluxel/services/commands';
import {standardServices} from '@pluxel/services';
import {BasePlugin,Plugin} from '@pluxel/core';
import {Workers,defineWorkerTask} from '@pluxel/services/workers';
import {resolve} from 'node:path';
const task = defineWorkerTask<number,number>(import.meta.url, './task.ts');
@Plugin()
class FrozenWorker extends BasePlugin {
 async init() {
  const value = await this.ctx.require(Workers).run(task,21);
  if(value !== 42) throw new Error('WRONG_WORKER_RESULT');
  process.stdout.write('FROZEN_WORKER_OK\\n');
 }
}
import {defineHostApplication} from '@pluxel/host';
export default defineHostApplication(() => ({name:'production-bridge', plugins:[FrozenWorker],sources:[pluginSource({kind:'directory',path:${JSON.stringify(sources)},include:['*.mjs']})],prepare:()=>{globalThis.__frameworkCommands=Commands},services:standardServices(),policy:{autoStart:[FrozenWorker,${JSON.stringify(address)}]}}))
`,
		)
		const buildScript = join(root, 'build.mts')
		await writeFile(
			buildScript,
			`
import { build } from ${JSON.stringify(import.meta.resolve('vite-plus/pack'))};
import { pluxel } from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)};
await build({cwd:${JSON.stringify(root)},entry:'app.ts',minify:false,plugins:[pluxel({delivery:'modules',variant:'headless',lint:false})],config:false});
`,
		)
		await promisify(execFile)(
			process.execPath,
			['--import', import.meta.resolve('tsx'), buildScript],
			{ timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
		)
		const deployed = join(root, 'relocated')
		await rename(join(root, 'dist'), deployed)
		await rm(join(root, 'task.ts'))
		const child = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict';

try {
 const { runHostApplication } = await import(${JSON.stringify(new URL('../../host/dist/index.mjs', import.meta.url).href)});
 globalThis.runtime = await runHostApplication(${JSON.stringify(join(deployed, 'app.mjs'))}, { startup: { root: ${JSON.stringify(root)}, mode: 'production', env: {}, bindings: {} }, sharedPackages: ['@pluxel/services','@pluxel/commands'] });
} finally { await globalThis.runtime?.close(); }
await assert.rejects(import(${JSON.stringify(pathToFileURL(join(root, 'mutable/node_modules/@pluxel/core/wrong.mjs')).href)}), /WRONG_CORE_COPY/);
console.log('NATIVE_MODULES_IDENTITY_OK');
`,
			],
			{ timeout: 30000 },
		)
		expect(child.stdout).toContain('DYNAMIC_STARTED')
		expect(child.stdout).toContain('FROZEN_WORKER_OK')
		expect(child.stdout).toContain('NATIVE_MODULES_IDENTITY_OK')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 60000)

it('preserves standalone handler and listener startup failures when Host cleanup also rejects', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-standalone-cleanup-'))
	const blocker = createServer()
	try {
		await new Promise<void>((resolve, reject) => {
			blocker.once('error', reject)
			blocker.listen(0, '127.0.0.1', resolve)
		})
		const blocked = blocker.address()
		if (!blocked || typeof blocked === 'string') throw new Error('probe listener did not bind')
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host', 'services'])
			await symlink(
				fileURLToPath(new URL(`../../${name}/`, import.meta.url)),
				join(root, 'node_modules/@pluxel', name),
				'dir',
			)
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'standalone-cleanup-probe', type: 'module' }),
		)
		await writeFile(
			join(root, 'app.ts'),
			`import {defineHostApplication} from '@pluxel/host';
import {resolveHostEnv} from '@pluxel/host/environment';
import {elysia,createElysiaHandler} from '@pluxel/services/elysia';
import {listenElysia} from '@pluxel/services/elysia/node';
export default defineHostApplication(startup=>({
 plugins:[],services:startup.env.PROBE_LISTENER==='1'?[elysia()]:[],
 prepare({host}){host.ctx.effects.defer(()=>{throw new Error('STANDALONE_CLEANUP_PROBE')},{phase:'shutdown'})},
 async launch({host}) {
  if(startup.env.PROBE_LISTENER!=='1') {createElysiaHandler(host);return}
  const env=resolveHostEnv(startup.env);
  await listenElysia(host,{hostname:env.hostBind,port:env.hostPort});
 }
}))`,
		)
		const buildScript = join(root, 'build.mts')
		await writeFile(
			buildScript,
			`import {build} from ${JSON.stringify(import.meta.resolve('vite-plus/pack'))}; import {pluxel} from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)}; await build({cwd:${JSON.stringify(root)},entry:'app.ts',plugins:[pluxel({variant:'headless',lint:false})],config:false})`,
		)
		await promisify(execFile)(
			process.execPath,
			['--import', import.meta.resolve('tsx'), buildScript],
			{ timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
		)
		for (const listener of [false, true]) {
			const child = await promisify(execFile)(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`
import assert from 'node:assert/strict';
const errors=error=>error instanceof AggregateError?error.errors.flatMap(errors):[error];
await assert.rejects(import(${JSON.stringify(pathToFileURL(join(root, 'dist/app.mjs')).href)}),error=>{
 assert(error instanceof AggregateError,error.stack);
 assert.equal(error.cause,error.errors[0]);
 ${listener ? "assert(errors(error).some(error=>error.code==='EADDRINUSE'))" : "const missing=errors(error).find(error=>error.code==='CONTEXT_CAPABILITY_MISSING'); assert(missing); assert.match(missing.capability,/elysia/i)"};
 assert(errors(error).some(error=>error.message==='STANDALONE_CLEANUP_PROBE'));
 return true;
});
console.log('STANDALONE_STARTUP_AND_CLEANUP_OK');
`,
				],
				{
					timeout: 30000,
					env: {
						...process.env,
						PROBE_LISTENER: listener ? '1' : '0',
						PLUXEL_HOST_BIND: '127.0.0.1',
						PLUXEL_HOST_PORT: listener ? String(blocked.port) : '0',
					},
				},
			)
			expect(child.stdout).toContain('STANDALONE_STARTUP_AND_CLEANUP_OK')
		}
	} finally {
		await new Promise<void>((resolve, reject) =>
			blocker.close((error) => (error ? reject(error) : resolve())),
		)
		await rm(root, { recursive: true, force: true })
	}
}, 60000)
