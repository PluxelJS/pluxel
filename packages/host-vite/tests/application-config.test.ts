import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('retains native Vite options and forwards application configSync to the prepared Host', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-vite-config-'))
	try {
		await writeFile(
			resolve(root, 'app.mjs'),
			`export default startup => ({
 plugins: [],
 configSync: {
  role: 'writer', identity: 'writer', scope: 'vite-config', replicas: [],
  artifact: { name: '@fixture/vite-config', catalogHash: 'a'.repeat(64) }
 },
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
 assert(prepared.configSync,'application configSync must reach createHost');
 assert.equal(prepared.configSync.status().role,'writer');
 assert.equal(prepared.config.status().version.seq,0);
 assert.deepEqual(prepared.configSync.status().savedVersion,prepared.config.status().version);
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
