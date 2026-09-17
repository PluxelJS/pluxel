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
		for (const name of ['core', 'host', 'host-dynamic', 'commands', 'services']) {
			await symlink(
				fileURLToPath(new URL(`../../${name}/`, import.meta.url)),
				join(root, 'node_modules/@pluxel', name),
				'dir',
			)
		}
		const sources = join(root, 'mutable/entries')
		await mkdir(sources, { recursive: true })
		await mkdir(join(root, 'mutable/node_modules/installed'), { recursive: true })
		await mkdir(join(root, 'mutable/node_modules/@pluxel/core'), { recursive: true })
		await writeFile(
			join(root, 'mutable/node_modules/@pluxel/core/package.json'),
			JSON.stringify({
				name: '@pluxel/core',
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
				type: 'module',
				exports: { './persistence': './wrong.mjs', './commands': './wrong.mjs' },
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
import {Persistence} from '@pluxel/services/persistence';
import {Commands} from '@pluxel/services/commands';
class Dynamic extends BasePlugin { init(){ if (!Array.isArray(this.ctx.require(Commands).list())) throw new Error('MISSING_COMMANDS'); if (Persistence !== globalThis.__frameworkPersistence) throw new Error('PERSISTENCE_IDENTITY_MISMATCH'); process.stdout.write('DYNAMIC_STARTED\\n') } }
Plugin()(Dynamic); __setPluginDefinition(Dynamic,{abiVersion:2,kind:'plugin',definition:${JSON.stringify(address.definition)}}); export {Dynamic};
`,
		)
		await writeFile(join(sources, 'installed.mjs'), "export * from 'installed'")
		await writeFile(
			join(root, 'app.ts'),
			`import {dynamicSource} from '@pluxel/host-dynamic';
import {Persistence,persistence} from '@pluxel/services/persistence';
import {commands} from '@pluxel/services/commands';
export default {name:'production-bridge', plugins:[],sources:[dynamicSource({kind:'directory',path:${JSON.stringify(sources)},include:['*.mjs']})],prepare:()=>{globalThis.__frameworkPersistence=Persistence},configure:()=>({services:[persistence({mode:'memory'}),commands()],state:{initial:{autoStart:[${JSON.stringify(address)}]}}})}
`,
		)
		const buildScript = join(root, 'build.mts')
		await writeFile(
			buildScript,
			`
import { build } from ${JSON.stringify(import.meta.resolve('tsdown'))};
import { pluxel } from ${JSON.stringify(new URL('../src/application.ts', import.meta.url).href)};
await build({cwd:${JSON.stringify(root)},entry:'app.ts',minify:false,plugins:[pluxel({variant:'headless',launcher:'host',sourceFrameworks:['@pluxel/services/persistence','@pluxel/services/commands'],lint:false})],config:false});
`,
		)
		await promisify(execFile)(
			process.execPath,
			['--import', import.meta.resolve('tsx'), buildScript],
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
 await application.start();
} finally { await application.stop(); }
await assert.rejects(import(${JSON.stringify(pathToFileURL(join(root, 'mutable/node_modules/@pluxel/core/wrong.mjs')).href)}), /WRONG_CORE_COPY/);
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
