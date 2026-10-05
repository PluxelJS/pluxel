import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { PluginNodeAddress } from '@pluxel/core'
import { PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
import { expect, it } from 'vitest'

const address = (name: string): PluginNodeAddress => ({
	definition: {
		entry: { kind: 'package-root', packageName: `@fixture/${name}` },
		exportName: 'Dynamic',
	},
	variant: 'default',
})

function builtModule(name: string): string {
	return `// [pluxel-plugin-semantics] Injected facts
import { BasePlugin, Plugin } from '@pluxel/core'
import { __setPluginDefinition } from '@pluxel/core/toolchain'
class Dynamic extends BasePlugin {}
Plugin()(Dynamic)
__setPluginDefinition(Dynamic, ${JSON.stringify({ abiVersion: PLUGIN_LOWERING_ABI_VERSION, kind: 'plugin', definition: address(name).definition })})
export { Dynamic }
`
}

it('admits one native snapshot and leaves later publications for a fresh process', async () => {
	const root = await mkdtemp(fileURLToPath(new URL('./.production-source-', import.meta.url)))
	try {
		await writeFile(join(root, 'initial.mjs'), builtModule('initial'))
		await writeFile(
			join(root, 'app.mjs'),
			`export default () => ({name:'production-source',plugins:[],sources:[{kind:'directory',path:'.',include:['initial.mjs','added.mjs','after-close.mjs']}],state:{initial:{autoStart:${JSON.stringify([address('initial'), address('added')])}}}})`,
		)
		const result = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict';
import {writeFile,rm} from 'node:fs/promises';
const {runHostApplication}=await import(${JSON.stringify(new URL('../../dist/index.mjs', import.meta.url).href)});
const {requirePluginService}=await import('@pluxel/core/internal');
const root=${JSON.stringify(root)};
const runtime=await runHostApplication('app.mjs',{startup:{root,mode:'production',env:{},bindings:{}}});
const initial=${JSON.stringify(address('initial'))},added=${JSON.stringify(address('added'))};
const service=requirePluginService(runtime.ctx);
try{
 assert.equal(service.isRunning(initial),true);
 await writeFile(root+'/added.mjs',${JSON.stringify(builtModule('added'))});
 assert.equal(service.isRunning(added),false);
 assert.equal(runtime.catalog().entries.length,1);
 await rm(root+'/initial.mjs');
 assert.equal(service.isRunning(initial),true);
 const overview=await runtime.status();
 assert.deepEqual(overview.statuses.find(status=>status.address.definition.entry.packageName==='@fixture/initial')?.execution,{kind:'native',origin:'source',artifact:{kind:'built-module'},update:{kind:'next-start'}});
}finally{await runtime.close()}
await writeFile(root+'/after-close.mjs',${JSON.stringify(builtModule('after-close'))});
assert.equal(service.isRunning(added),false);
console.log('NATIVE_SNAPSHOT_OK');
`,
			],
			{ timeout: 10000 },
		)
		expect(result.stdout.trim()).toBe('NATIVE_SNAPSHOT_OK')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

it('preserves startup and cleanup failures while draining resources and releasing native bindings', async () => {
	const root = await mkdtemp(fileURLToPath(new URL('./.production-source-', import.meta.url)))
	try {
		await writeFile(join(root, 'late.mjs'), 'export const value=42')
		await writeFile(
			join(root, 'app.mjs'),
			`export const unused=import.meta.resolve('./late.mjs');
export default () => ({plugins:[],state:{mode:'memory'},prepare({host,startup}){
 const {cleanup,failure,cleanupFailure}=startup.bindings;
 host.ctx.effects.defer(()=>cleanup.push('final'),{phase:'final'});
 host.ctx.effects.defer(()=>{cleanup.push('shutdown');if(cleanupFailure)throw cleanupFailure},{phase:'shutdown'});
 throw failure;
}})`,
		)
		await writeFile(
			join(root, 'repaired.mjs'),
			`import {value} from './late.mjs';export default()=>({plugins:[],state:{mode:'memory'},prepare({startup}){startup.bindings.values.push(value)}})`,
		)
		const result = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict';
const {runHostApplication}=await import(${JSON.stringify(new URL('../../dist/index.mjs', import.meta.url).href)});
const root=${JSON.stringify(root)},cleanup=[],failure=new Error('prepare failed'),cleanupFailure=new Error('cleanup failed');
const startup={root,mode:'production',env:{},bindings:{cleanup,failure}};
await assert.rejects(runHostApplication('app.mjs',{startup}),error=>error===failure);
assert.deepEqual(cleanup,['shutdown','final']);
cleanup.length=0;
await assert.rejects(runHostApplication('app.mjs',{startup:{...startup,bindings:{cleanup,failure,cleanupFailure}}}),error=>{
 assert.ok(error instanceof AggregateError);
 assert.equal(error.cause,failure);
 const leaves=error=>error instanceof AggregateError?error.errors.flatMap(leaves):[error];
 assert.deepEqual(leaves(error),[failure,cleanupFailure]);
 return true;
});
assert.deepEqual(cleanup,['shutdown','final']);
const values=[];
const repaired=await runHostApplication('repaired.mjs',{startup:{...startup,bindings:{values}},sharedPackages:['private-extra']});
await repaired.close();
assert.deepEqual(values,[42]);
console.log('NATIVE_CLEANUP_OK');
`,
			],
			{ timeout: 10000 },
		)
		expect(result.stdout.trim()).toBe('NATIVE_CLEANUP_OK')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
