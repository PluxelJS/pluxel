import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PluginNodeAddress } from '@pluxel/core'
import { PLUGIN_LOWERING_ABI_VERSION } from '@pluxel/core/toolchain'
import { expect, it } from 'vitest'
import { runNodeModule } from '../support/node'
import { createWorkspace, hostPackage } from '../support/workspace'

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
	await using workspace = await createWorkspace('production-source')
	const { root } = workspace
	await writeFile(join(root, 'initial.mjs'), builtModule('initial'))
	await writeFile(join(root, 'reexport.mjs'), "export {Dynamic} from './initial.mjs'")
	await writeFile(
		join(root, 'app.mjs'),
		`export default () => ({name:'production-source',sources:[{directory:'.',include:['initial.mjs','reexport.mjs','added.mjs','after-close.mjs']}],pluginNodes:${JSON.stringify(['initial', 'added'].map((name) => ({ definition: address(name).definition, autoStart: true })))},acceptStartup:({status})=>status.statuses.some(node=>node.address.definition.entry.packageName==='@fixture/initial'&&node.lifecycleState==='running')})`,
	)
	const result = await runNodeModule(`
import assert from 'node:assert/strict';
import {writeFile,rm} from 'node:fs/promises';
const {runHostApplication}=await import(${JSON.stringify(new URL('dist/index.mjs', hostPackage).href)});
const {readPluginSourceImpact}=await import(${JSON.stringify(new URL('dist/sources.mjs', hostPackage).href)});
const {requirePluginService}=await import('@pluxel/core/internal');
const root=${JSON.stringify(root)};
const runtime=await runHostApplication('app.mjs',{startup:{root,mode:'production',env:{},bindings:{}}});
const initial=${JSON.stringify(address('initial'))},added=${JSON.stringify(address('added'))};
const service=requirePluginService(runtime.ctx);
try{
 assert.equal(service.isRunning(initial),true);
 const impact=readPluginSourceImpact(runtime.ctx,[{name:'@fixture/initial',file:root+'/initial.mjs'},{name:'@fixture/reexport',file:root+'/reexport.mjs'}]);
 assert.deepEqual(impact.definitions.map(({address,packageName,origin,nodes})=>[packageName,address,origin,nodes]),['@fixture/initial','@fixture/reexport'].map(name=>[name,initial.definition,'shared',[{address:initial,running:true,requiredConsumers:[],optionalConsumers:[]}]]));
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
`)
	expect(result.stdout.trim()).toBe('NATIVE_SNAPSHOT_OK')
})

it('preserves startup and cleanup failures while draining resources and releasing native bindings', async () => {
	await using workspace = await createWorkspace('production-source')
	const { root } = workspace
	await writeFile(join(root, 'late.mjs'), 'export const value=42')
	await writeFile(
		join(root, 'app.mjs'),
		`export const unused=import.meta.resolve('./late.mjs');
export default () => ({plugins:[],policy: { document: false },prepare({host,startup}){
 const {cleanup,failure,cleanupFailure}=startup.bindings;
 host.ctx.effects.defer(()=>cleanup.push('final'),{phase:'final'});
 host.ctx.effects.defer(()=>{cleanup.push('shutdown');if(cleanupFailure)throw cleanupFailure},{phase:'shutdown'});
 throw failure;
}})`,
	)
	await writeFile(
		join(root, 'repaired.mjs'),
		`import {value} from './late.mjs';export default()=>({plugins:[],policy: { document: false },prepare({startup}){startup.bindings.values.push(value)}})`,
	)
	const result = await runNodeModule(`
import assert from 'node:assert/strict';
const {runHostApplication}=await import(${JSON.stringify(new URL('dist/index.mjs', hostPackage).href)});
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
`)
	expect(result.stdout.trim()).toBe('NATIVE_CLEANUP_OK')
})
