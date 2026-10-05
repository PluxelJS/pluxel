import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('reuses successful namespace ownership admission, observes late imports and rejects a conflicting owner', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-native-owner-cost-'))
	const count = 64
	const owner = resolve(root, 'owner')
	try {
		await mkdir(resolve(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host'])
			await symlink(
				fileURLToPath(new URL(`../../${name}`, import.meta.url)),
				resolve(root, 'node_modules/@pluxel', name),
			)
		await mkdir(owner)
		await mkdir(resolve(root, 'conflict'))
		await writeFile(
			resolve(root, 'package.json'),
			JSON.stringify({ name: 'native-cost-app', version: '1.0.0', type: 'module' }),
		)
		const manifest = JSON.stringify({ name: 'native-cost-owner', version: '1.0.0', type: 'module' })
		await writeFile(resolve(owner, 'package.json'), manifest)
		await writeFile(resolve(root, 'conflict/package.json'), manifest)
		const lowered = (name: string) =>
			`import {BasePlugin,Plugin} from '@pluxel/core';import {__setPluginDefinition} from '@pluxel/core/toolchain';class ${name} extends BasePlugin{};Plugin()(${name});__setPluginDefinition(${name},{abiVersion:2,kind:'plugin',definition:${JSON.stringify({ entry: { kind: 'package-root', packageName: 'native-cost-owner' }, exportName: name })}});export {${name}};`
		await Promise.all(
			Array.from({ length: count }, (_, index) =>
				writeFile(
					resolve(owner, `entry-${index}.mjs`),
					lowered(`Native${index}`) + (index === 0 ? "export {Late} from './late.mjs';" : ''),
				),
			),
		)
		await writeFile(resolve(owner, 'late.mjs'), lowered('Late'))
		await writeFile(
			resolve(root, 'app.mjs'),
			"export default async startup=>{startup.bindings.capture?.();await import('./owner/late.mjs');return{plugins:[],sources:[{kind:'directory',path:'owner',include:['entry-*.mjs']}],state:{mode:'memory'}}}",
		)
		await writeFile(
			resolve(root, 'conflict/wrapper.mjs'),
			"export {Native0} from '../owner/entry-0.mjs'",
		)
		await writeFile(
			resolve(root, 'conflict-app.mjs'),
			"import {Native0} from './owner/entry-0.mjs';export default()=>({plugins:[Native0],sources:[{kind:'file',path:'conflict/wrapper.mjs'}],state:{mode:'memory'}})",
		)
		const run = (script: string) =>
			promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
				timeout: 10000,
			})
		const hostEntry = JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)
		const internalEntry = JSON.stringify(new URL('../dist/internal.mjs', import.meta.url).href)
		const positive = await run(`
import assert from 'node:assert/strict';import filesystem from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const {runHostApplication}=await import(${hostEntry});const {readLoadedPluginModule}=await import(${internalEntry});
const root=${JSON.stringify(root)},owner=${JSON.stringify(owner)},manifest=owner+'/package.json';
const original=filesystem.readFileSync;let reads=0,host;const captures=[];
filesystem.readFileSync=(...args)=>{if(String(args[0])===manifest)reads++;return original(...args)};syncBuiltinESMExports();
const options={startup:{root,mode:'production',env:{},bindings:{capture:()=>captures.push(reads)}}};
try{
 host=await runHostApplication('app.mjs',options);
 assert.equal(host.catalog().entries.length,${count + 1});
 assert(reads>=${count},'owner validation was skipped');assert(reads<=${4 * (count + 1) + 4},'repeated full closure owner reads: '+reads);
 const {Late}=await import(${JSON.stringify(pathToFileURL(resolve(owner, 'late.mjs')).href)});
 assert.equal(readLoadedPluginModule(Late)?.package.root,owner);
 await host.close();reads=0;
 host=await runHostApplication('app.mjs',options);
 assert.equal(host.catalog().entries.length,${count + 1});
 assert.deepEqual(captures,[0,0],'cached application prefix must exclude later source namespaces');
 console.log('NATIVE_OWNER_ADMISSION_REUSE_OK');
}finally{filesystem.readFileSync=original;syncBuiltinESMExports();await host?.close()}
`)
		expect(positive.stdout.trim()).toBe('NATIVE_OWNER_ADMISSION_REUSE_OK')
		const negative = await run(`
import assert from 'node:assert/strict';const {runHostApplication}=await import(${hostEntry});
await assert.rejects(runHostApplication('conflict-app.mjs',{startup:{root:${JSON.stringify(root)},mode:'production',env:{},bindings:{}}}),/loaded Plugin has conflicting physical package owners/);
console.log('NATIVE_OWNER_CONFLICT_OK');
`)
		expect(negative.stdout.trim()).toBe('NATIVE_OWNER_CONFLICT_OK')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('admits only lowered native ESM and checks shared installation facts without loading compiler tools', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-native-admission-'))
	const put = (name: string, content: string) => writeFile(resolve(root, name), content)
	try {
		await mkdir(resolve(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host'])
			await symlink(
				fileURLToPath(new URL(`../../${name}`, import.meta.url)),
				resolve(root, 'node_modules/@pluxel', name),
			)
		const applicationManifest = { name: 'native-admission', version: '1.0.0', type: 'module' }
		await put('package.json', JSON.stringify(applicationManifest))
		const definition = {
			entry: { kind: 'package-root', packageName: 'native-admission' },
			exportName: 'Native',
		}
		const lowered = `import {BasePlugin,Plugin} from '@pluxel/core'; import {__setPluginDefinition} from '@pluxel/core/toolchain'; class Native extends BasePlugin {}; Plugin()(Native); __setPluginDefinition(Native,{abiVersion:2,kind:'plugin',definition:${JSON.stringify(definition)}}); export {Native};`
		await put('never.mjs', "throw new Error('SOURCE_PRELOAD')")
		await put('entry.mjs', lowered + "\nexport const location=import.meta.resolve('./never.mjs')")
		const run = async (entry = 'entry.mjs') => {
			await put(
				'app.mjs',
				`export default () => ({plugins:[],sources:[{kind:'file',path:${JSON.stringify(entry)}}],state:{mode:'memory'}})`,
			)
			return promisify(execFile)(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					`
import {registerHooks} from 'node:module'; import assert from 'node:assert/strict';
registerHooks({resolve(id,context,next){if(/^(?:vite|@pluxel\\/host-vite|@pluxel\\/rolldown|rolldown|oxc-parser|oxc-resolver|tsdown|tsx|typescript|chokidar)(?:$|\\/)/.test(id))throw new Error('NATIVE_LOADED_TOOL:'+id);return next(id,context)}});
const {runHostApplication}=await import(${JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)});
const host=await runHostApplication('app.mjs',{startup:{root:${JSON.stringify(root)},mode:'production',env:{},bindings:{}}});
try { if(host.catalog().entries.length!==1)throw new Error('MISSING_NATIVE'); console.log('NATIVE_ONLY_OK') } finally { await host.close() }
await assert.rejects(runHostApplication('app.mjs',{startup:{root:${JSON.stringify(root)},mode:'production',env:{},bindings:{}},sharedPackages:['private-extra']}),{code:'PLUGIN_SHARED_BINDING_CONFLICT'});
`,
				],
				{ timeout: 10000 },
			)
		}
		const admitted = await run()
		expect(admitted.stdout).toContain('NATIVE_ONLY_OK')
		await put(
			'entry.mjs',
			"import {BasePlugin,Plugin} from '@pluxel/core'; export class Native extends BasePlugin {}; Plugin()(Native)",
		)
		await expect(run()).rejects.toThrow(/lower|definition|candidate/i)
		await mkdir(resolve(root, 'cjs'))
		await put('cjs/package.json', JSON.stringify({ type: 'commonjs' }))
		await put('cjs/entry.js', "throw new Error('CJS_EXECUTED')")
		await expect(run('cjs/entry.js')).rejects.toThrow('must be precompiled ESM')
		await put('entry.mjs', lowered.replace('abiVersion:2', 'abiVersion:999'))
		await expect(run()).rejects.toThrow(/ABI|abi/)
		await put('raw.ts', 'export const value: number = 1')
		await put('entry.mjs', "import './raw.ts';\n" + lowered)
		await expect(run()).rejects.toThrow(/must be precompiled.*raw.ts/)
		await mkdir(resolve(root, 'nested/node_modules/@pluxel/core'), { recursive: true })
		await put('entry.mjs', "export * from './nested/entry.mjs'")
		await put('nested/entry.mjs', lowered)
		const actual = JSON.parse(
			await readFile(fileURLToPath(new URL('../../core/package.json', import.meta.url)), 'utf8'),
		)
		const wrong = resolve(root, 'nested/node_modules/@pluxel/core')
		await writeFile(resolve(wrong, 'index.mjs'), "throw new Error('WRONG_CORE_EXECUTED')")
		for (const version of [undefined, '999.0.0']) {
			await writeFile(
				resolve(wrong, 'package.json'),
				JSON.stringify({
					name: '@pluxel/core',
					type: 'module',
					version,
					exports: { '.': './index.mjs', './toolchain': './index.mjs' },
				}),
			)
			await expect(run()).rejects.toThrow(
				/shared package admission failed.*installed (?:<missing>|999.0.0)/,
			)
		}
		await writeFile(
			resolve(wrong, 'package.json'),
			JSON.stringify({
				name: '@pluxel/core',
				type: 'module',
				version: actual.version,
				exports: { '.': './index.mjs', './toolchain': './index.mjs' },
			}),
		)
		const compatible = await run()
		expect(compatible.stdout).toContain('NATIVE_ONLY_OK')
		const malformedRanges: readonly unknown[] = [
			null,
			[],
			'invalid',
			{ '@pluxel/core': 42 },
			{ '@pluxel/core': ' ' },
		]
		for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
			for (const ranges of malformedRanges) {
				await put('package.json', JSON.stringify({ ...applicationManifest, [field]: ranges }))
				await expect(run()).rejects.toThrow(`${field} must map package names to non-empty ranges`)
			}
		}
		// Optional installation requirements override dependencies; peers keep their independent priority.
		await put(
			'package.json',
			JSON.stringify({
				...applicationManifest,
				dependencies: { '@pluxel/core': '999.0.0' },
				optionalDependencies: { '@pluxel/core': actual.version },
			}),
		)
		const optionalOverride = await run()
		expect(optionalOverride.stdout).toContain('NATIVE_ONLY_OK')
		await put(
			'package.json',
			JSON.stringify({
				...applicationManifest,
				dependencies: { '@pluxel/core': actual.version },
				optionalDependencies: { '@pluxel/core': '999.0.0' },
			}),
		)
		await expect(run()).rejects.toThrow(/shared package admission failed.*requirement 999\.0\.0/)
		await put(
			'package.json',
			JSON.stringify({
				...applicationManifest,
				peerDependencies: { '@pluxel/core': actual.version },
				optionalDependencies: { '@pluxel/core': '999.0.0' },
			}),
		)
		const peerPriority = await run()
		expect(peerPriority.stdout).toContain('NATIVE_ONLY_OK')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 30000)

it('snapshots startup before loading, rejects invalid inputs before evaluation and releases unresolved bindings', async () => {
	const root = await mkdtemp(fileURLToPath(new URL('./.native-boundary-', import.meta.url)))
	try {
		await writeFile(resolve(root, 'never.mjs'), "throw new Error('UNUSED_MODULE_EXECUTED')")
		await writeFile(resolve(root, 'invalid.mjs'), "throw new Error('INVALID_INPUT_EXECUTED')")
		const application = `export const unused=import.meta.resolve('./never.mjs'); export default startup=>({plugins:[],state:{mode:'memory'},prepare(){startup.bindings.capture({root:startup.root,value:startup.env.VALUE})}})`
		await writeFile(resolve(root, 'first.mjs'), application)
		await writeFile(resolve(root, 'second.mjs'), application)
		await writeFile(resolve(root, 'preloaded.mjs'), 'export default ()=>({plugins:[]})')
		await writeFile(resolve(root, 'no-factory.mjs'), 'export const product={}')
		const result = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict';
const {runHostApplication}=await import(${JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)});
const root=${JSON.stringify(root)},seen=[];
const startup={root,mode:'production',env:{VALUE:'initial'},bindings:{capture:value=>seen.push(value)}};
for(const [input,message] of [[null,/startup must be an object/],[{...startup,root:'relative'},/root must be absolute/],[{...startup,mode:'unknown'},/startup.mode/],[{...startup,env:{SECRET:42}},/startup.env.SECRET/],[{...startup,bindings:[]},/startup.bindings/],[{...startup,deployment:undefined},/cannot declare a frozen deployment/]])await assert.rejects(runHostApplication('invalid.mjs',{startup:input}),message);
await assert.rejects(runHostApplication('invalid.mjs',{startup,sharedPackages:'wrong'}),/sharedPackages must be an array/);
await assert.rejects(runHostApplication(()=>({plugins:[]}),{startup}),/entry must be a module path/);
await assert.rejects(runHostApplication('invalid.mjs',{startup,typo:true}),/unsupported typo/);
const sharedPackages=[];
const pending=runHostApplication('first.mjs',{startup,sharedPackages});
startup.root='/changed';startup.env.VALUE='changed';sharedPackages.push('private-extra');
const first=await pending;await first.close();
assert.deepEqual(seen,[{root,value:'initial'}]);
const second=await runHostApplication('second.mjs',{startup:{...startup,root},sharedPackages:['private-extra']});await second.close();
await import(${JSON.stringify(pathToFileURL(resolve(root, 'preloaded.mjs')).href)});
await assert.rejects(runHostApplication('preloaded.mjs',{startup:{...startup,root}}),{code:'PLUGIN_SHARED_BINDING_CONFLICT'});
await assert.rejects(runHostApplication('no-factory.mjs',{startup:{...startup,root}}),/must export a default factory/);
console.log('NATIVE_STARTUP_BOUNDARY_OK');
`,
			],
			{ timeout: 10000 },
		)
		expect(result.stdout.trim()).toBe('NATIVE_STARTUP_BOUNDARY_OK')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
