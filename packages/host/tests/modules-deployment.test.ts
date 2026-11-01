import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('binds native synchronization to the compiled entry package manifest while preserving the application root', async () => {
	const root = await mkdtemp(fileURLToPath(new URL('./.modules-deployment-', import.meta.url)))
	try {
		await mkdir(join(root, 'dist'))
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host'])
			await symlink(
				fileURLToPath(new URL(`../../${name}`, import.meta.url)),
				join(root, 'node_modules/@pluxel', name),
			)
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
return {plugins:[],...(startup.bindings.synchronize?{configSync:{role:'writer',identity:'writer',replicas:[],scope:'modules',artifact:{name:startup.env.ARTIFACT_NAME,catalogHash:'a'.repeat(64)}}}:{})};
}`,
		)
		const script = `
import assert from 'node:assert/strict';
import {writeFile,rm} from 'node:fs/promises';
import {runHostApplication} from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)};
const root=${JSON.stringify(root)},artifactRoot=root+'/dist',manifestFile=artifactRoot+'/pluxel-deployment.json';
const artifact={name:'@fixture/deployed-application',catalogHash:'a'.repeat(64)};
let captured,calls=0;
const startup={root,mode:'production',env:{ARTIFACT_NAME:artifact.name},bindings:{synchronize:false,capture:value=>{captured=value;calls++}}};
let host=await runHostApplication('./dist/app.mjs',{startup});await host.close();assert.equal(captured.deployment,undefined);
const manifest={version:1,kind:'pluxel-modules-application',application:artifact,server:{target:'node',entry:'app.mjs'},capabilities:{workbench:{included:false}}};
await writeFile(manifestFile,JSON.stringify(manifest));startup.bindings.synchronize=true;
host=await runHostApplication('./dist/app.mjs',{startup});
assert.equal(captured.root,root);assert.deepEqual(captured.deployment,{root:artifactRoot,target:'node',variant:'headless',application:artifact});
assert(Object.isFrozen(captured.deployment.application));assert.deepEqual(host.configSync.status().artifact,artifact);await host.close();
await assert.rejects(runHostApplication('./dist/app.mjs',{startup:{...startup,env:{ARTIFACT_NAME:'wrong-application'}}}),/must match the deployed application artifact/);
const before=calls;
await writeFile(manifestFile,JSON.stringify({...manifest,server:{target:'node',entry:'other.mjs'}}));
await assert.rejects(runHostApplication('./dist/app.mjs',{startup}),/entry does not match/);assert.equal(calls,before);
await rm(manifestFile);
await assert.rejects(runHostApplication('./dist/app.mjs',{startup}),/requires the deployed application manifest/);
await writeFile(manifestFile,JSON.stringify({...manifest,kind:'pluxel-static-application'}));
await assert.rejects(runHostApplication('./dist/app.mjs',{startup}),/requires a modules application deployment manifest/);
console.log('MODULE_DEPLOYMENT_FACTS_OK');
`
		const result = await promisify(execFile)(
			process.execPath,
			[
				'--import',
				fileURLToPath(new URL('../../rolldown/node_modules/tsx/dist/loader.mjs', import.meta.url)),
				'--conditions=@pluxel/source',
				'--input-type=module',
				'-e',
				script,
			],
			{ timeout: 15_000 },
		)
		expect(result.stdout.trim()).toBe('MODULE_DEPLOYMENT_FACTS_OK')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
