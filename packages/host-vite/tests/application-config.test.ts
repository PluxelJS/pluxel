import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('retains native Vite options and forwards the application config policy to the prepared Host', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-vite-config-'))
	try {
		await writeFile(
			resolve(root, 'app.mjs'),
			`export default startup => ({
 plugins: [],
 runtime: { documents: { config: { readOnly: true } } },
 prepare({host}) { startup.bindings.capture(host) }
})`,
		)
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict';
import {createServer} from 'vite';
import {host} from ${JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)};
let prepared;
let nativeConfig;
const server = await createServer({
 root:${JSON.stringify(root)},configFile:false,logLevel:'silent',appType:'custom',
 define:{__NATIVE_OPTION__:JSON.stringify('native-vite')},
 server:{middlewareMode:true},
 plugins:[{name:'test:native-config',configResolved(config){nativeConfig=config.define.__NATIVE_OPTION__}},
  host({entry:'app.mjs',bindings:{capture(value){prepared=value}}})]
});
try {
 assert.equal(nativeConfig,JSON.stringify('native-vite'));
 assert.equal(prepared.config.status().readonly,true);
 console.log('NATIVE_VITE_AND_APPLICATION_CONFIG_OK');
} finally {await server.close()}
`,
			],
			{
				cwd: resolve(import.meta.dirname, '..'),
				env: { ...process.env, NODE_ENV: 'development' },
				timeout: 15_000,
			},
		)
		expect(stdout).toContain('NATIVE_VITE_AND_APPLICATION_CONFIG_OK')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 20_000)

it('preserves raw saved config across application factory HMR and configuration mode changes', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-vite-config-records-'))
	try {
		await mkdir(resolve(root, 'node_modules/@pluxel'), { recursive: true })
		for (const name of ['core', 'host'])
			await symlink(
				resolve(import.meta.dirname, '../../', name),
				resolve(root, 'node_modules/@pluxel', name),
				'dir',
			)
		await mkdir(resolve(root, 'data'))
		await writeFile(
			resolve(root, 'package.json'),
			JSON.stringify({ name: 'config-hmr-fixture', type: 'module' }),
		)
		await writeFile(
			resolve(root, 'owner.ts'),
			`
import { BasePlugin, Plugin } from '@pluxel/core'
const schema = { '~standard': { version: 1, vendor: 'config-hmr', validate(value) { return { value } } } }
@Plugin()
export class Owner extends BasePlugin { readonly config = this.configs.use(schema) }
`,
		)
		await writeFile(
			resolve(root, 'app.ts'),
			`
import * as fs from 'node:fs'
import { Passthrough } from '@pluxel/core/fs'
import { Owner } from './owner.ts'
const declaredLimit = 200
const configMode = 'saved-first'
export default startup => ({
 plugins: [Owner],
 config: { mode: configMode, records: [{ owner: Owner, config: { limit: declaredLimit } }] },
 policy: { startTimeoutMs: 12345 },
 runtime: {
  zenfs: { mounts: { '/': { backend: Passthrough, fs, prefix: startup.bindings.prefix } } },
  documents: { state: false },
 },
 prepare({host}) { startup.bindings.capture(host, Owner.nodeAddress()) }
})
`,
		)
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {createServer} from 'vite';
import {host} from ${JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)};
const root = ${JSON.stringify(root)};
let prepared, owner, onPrepared;
const server = await createServer({root,configFile:false,logLevel:'error',appType:'custom',server:{port:0,host:'127.0.0.1'},plugins:[host({entry:'app.ts',bindings:{prefix:root+'/data',capture(value,address){prepared=value;owner=address;onPrepared?.(value)}}})]});
await server.listen();
const read = async () => JSON.parse(await readFile(root+'/data/services/host/config/config.json','utf8')).json;
const reload = async (source) => {
 const replaced = new Promise(resolve => { onPrepared = resolve });
 // Chokidar 5 suppresses a second change event for the same path within 50 ms.
 await delay(75);
 await writeFile(root+'/app.ts', source);
 let timer;
 let next;
 try { next = await Promise.race([replaced, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Application replacement was not observed')), 5000) })]) }
 finally { clearTimeout(timer) }
 await next.start();
 return next;
};
try {
 assert.equal((await prepared.policy.get()).effective.startTimeoutMs,12345);
 assert.equal((await prepared.config.get(owner)).config.limit,200);
 assert.equal((await prepared.config.patch(owner,{set:{limit:200}})).ok,true);
 let source = await readFile(root+'/app.ts','utf8');
 source=source.replace('declaredLimit = 200','declaredLimit = 100').replace("configMode = 'saved-first'","configMode = 'declared-first'");
 const first = prepared;
 await reload(source);
 assert.notEqual(prepared,first);
 assert.equal((await prepared.config.get(owner)).config.limit,100);
 const patched = await prepared.config.patch(owner,{set:{editable:true}});
 assert.equal(patched.ok,true);
 assert.deepEqual((await read()).plugins[0].config,{limit:200,editable:true});
 source=source.replace("configMode = 'declared-first'","configMode = 'saved-first'");
 await reload(source);
 assert.deepEqual({...((await prepared.config.get(owner)).config)},{limit:200,editable:true});
 assert.deepEqual((await read()).plugins[0].config,{limit:200,editable:true});
 console.log('HMR_RAW_CONFIG_PRESERVED');
} finally {await server.close()}
`,
			],
			{
				cwd: resolve(import.meta.dirname, '..'),
				env: { ...process.env, NODE_ENV: 'development' },
				timeout: 20_000,
			},
		)
		expect(stdout).toContain('HMR_RAW_CONFIG_PRESERVED')
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 25_000)
