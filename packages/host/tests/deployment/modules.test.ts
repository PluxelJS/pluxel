import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { runNodeModule } from '../support/node'
import { createWorkspace, hostPackage } from '../support/workspace'

it('loads deployment facts from the compiled entry package while preserving the application root', async () => {
	await using workspace = await createWorkspace('modules-deployment', ['core', 'host'])
	const { root } = workspace
	await mkdir(join(root, 'dist'))
	await writeFile(
		join(root, 'package.json'),
		JSON.stringify({ name: 'application-root', type: 'module' }),
	)
	await writeFile(
		join(root, 'dist/package.json'),
		JSON.stringify({ name: '@fixture/deployed-application', version: '1.0.0', type: 'module' }),
	)
	await writeFile(
		join(root, 'dist/app.mjs'),
		`export default startup=>{
startup.bindings.capture(startup);
return {plugins:[]};
}`,
	)
	const script = `
import assert from 'node:assert/strict';
import {writeFile,rm} from 'node:fs/promises';
import {runHostApplication} from ${JSON.stringify(new URL('src/index.ts', hostPackage).href)};
const root=${JSON.stringify(root)},artifactRoot=root+'/dist',manifestFile=artifactRoot+'/pluxel-deployment.json';
const artifact={name:'@fixture/deployed-application',catalogHash:'a'.repeat(64)};
let captured,calls=0;
const startup={root,mode:'production',env:{ARTIFACT_NAME:artifact.name},bindings:{capture:value=>{captured=value;calls++}}};
let host=await runHostApplication('./dist/app.mjs',{startup});await host.close();assert.equal(captured.deployment,undefined);
const manifest={version:1,kind:'pluxel-modules-application',application:artifact,server:{target:'node',entry:'app.mjs'},capabilities:{workbench:{included:false}}};
await writeFile(manifestFile,JSON.stringify(manifest));
host=await runHostApplication('./dist/app.mjs',{startup});
assert.equal(captured.root,root);assert.deepEqual(captured.deployment,{root:artifactRoot,target:'node',variant:'headless',delivery:'modules',application:artifact});
assert(Object.isFrozen(captured.deployment.application));await host.close();
const before=calls;
await writeFile(manifestFile,JSON.stringify({...manifest,server:{target:'node',entry:'other.mjs'}}));
await assert.rejects(runHostApplication('./dist/app.mjs',{startup}),/entry does not match/);assert.equal(calls,before);
await rm(manifestFile);
host=await runHostApplication('./dist/app.mjs',{startup});await host.close();assert.equal(captured.deployment,undefined);
await writeFile(manifestFile,JSON.stringify({...manifest,kind:'pluxel-static-application'}));
await assert.rejects(runHostApplication('./dist/app.mjs',{startup}),/requires a modules application deployment manifest/);
console.log('MODULE_DEPLOYMENT_FACTS_OK');
`
	const result = await runNodeModule(script, 15_000, [
		'--import',
		fileURLToPath(new URL('../rolldown/node_modules/tsx/dist/loader.mjs', hostPackage)),
		'--conditions=@pluxel/source',
	])
	expect(result.stdout.trim()).toBe('MODULE_DEPLOYMENT_FACTS_OK')
})
