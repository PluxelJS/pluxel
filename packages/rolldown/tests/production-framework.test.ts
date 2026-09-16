import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
it('shares frozen framework identity with installed modules in a fresh Node process', async () => {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-production-bridge-'))
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['runtime', 'core', 'host', 'host-dynamic', 'commands']) {
			await symlink(
				fileURLToPath(new URL(`../../${name}/`, import.meta.url)),
				join(root, 'node_modules/@pluxel', name),
				'dir',
			)
		}
		const sources = join(root, 'mutable/entries')
		await mkdir(sources, { recursive: true })
		await mkdir(join(root, 'mutable/node_modules/installed'), { recursive: true })
		await mkdir(join(root, 'mutable/node_modules/@pluxel/runtime'), { recursive: true })
		await writeFile(
			join(root, 'mutable/node_modules/@pluxel/runtime/package.json'),
			JSON.stringify({
				name: '@pluxel/runtime',
				type: 'module',
				exports: { '.': './wrong.mjs', './toolchain': './wrong.mjs' },
			}),
		)
		await writeFile(
			join(root, 'mutable/node_modules/@pluxel/runtime/wrong.mjs'),
			'throw new Error("WRONG_RUNTIME_COPY")',
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
import {BasePlugin,Plugin} from '@pluxel/runtime';
import {__setPluginDefinition} from '@pluxel/runtime/toolchain';
import {ElysiaWS} from 'elysia/ws';
if (typeof ElysiaWS !== 'function') throw new Error('MISSING_ELYSIA_WS');
class Dynamic extends BasePlugin { init(){ process.stdout.write('DYNAMIC_STARTED\\n') } }
Plugin()(Dynamic); __setPluginDefinition(Dynamic,{abiVersion:2,kind:'plugin',definition:${JSON.stringify(address.definition)}}); export {Dynamic};
`,
		)
		await writeFile(join(sources, 'installed.mjs'), "export * from 'installed'")
		await writeFile(
			join(root, 'app.ts'),
			`import {dynamicSource} from '@pluxel/host-dynamic';
export default {name:'production-bridge', plugins:[],sources:[dynamicSource({kind:'directory',path:${JSON.stringify(sources)},include:['*.mjs']})],configure:()=>({logging:false,configService:{mode:'memory'},runtimeState:{mode:'memory',snapshot:{autoStart:[${JSON.stringify(address)}]}}})}
`,
		)
		const buildScript = join(root, 'build.mts')
		await writeFile(
			buildScript,
			`
import { build } from ${JSON.stringify(import.meta.resolve('tsdown'))};
import { application } from ${JSON.stringify(new URL('../src/cli/static-application.ts', import.meta.url).href)};
await build({...application({cwd:${JSON.stringify(root)},entry:'app.ts',variant:'headless',launcher:'fetch',managedDatabaseDrivers:[],minify:false,lint:false}),config:false});
`,
		)
		await promisify(execFile)(
			fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url)),
			[buildScript],
			{ timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
		)
		const child = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict';
const application = await import(${JSON.stringify(pathToFileURL(join(root, 'dist/app.mjs')).href)});
try {
 const report = await application.start();
 assert(report.entries.some(entry => entry.rootExportName === 'Dynamic' && entry.status === 'started'));
} finally { await application.stop(); }
await assert.rejects(import(${JSON.stringify(pathToFileURL(join(root, 'mutable/node_modules/@pluxel/runtime/wrong.mjs')).href)}), /WRONG_RUNTIME_COPY/);
console.log('BUNDLED_DYNAMIC_IDENTITY_OK');
`,
			],
			{ timeout: 30000 },
		)
		expect(child.stdout).toContain('DYNAMIC_STARTED')
		expect(child.stdout).toContain('BUNDLED_DYNAMIC_IDENTITY_OK')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 60000)
