import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('lets a development connection owner observe Host drain before releasing borrowed bindings', async () => {
	const root = await mkdtemp(resolve(tmpdir(), 'pluxel-development-drain-'))
	try {
		await writeFile(
			resolve(root, 'app.mjs'),
			`export default startup => ({
 plugins: [],
 prepare({host}) {
  host.ctx.effects.defer(() => { startup.bindings.write('HOST_DRAINED'); throw new Error('OWNED_CLOSE_FAILED') })
 }
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
import {host,closeHostViteSession} from ${JSON.stringify(new URL('../dist/index.mjs', import.meta.url).href)};
let connectionOpen = true;
const server = await createServer({root:${JSON.stringify(root)},configFile:false,logLevel:'silent',appType:'custom',server:{middlewareMode:true},plugins:[host({entry:'app.mjs',bindings:{write(value){assert(connectionOpen);console.log(value)}}})]});
const closing = closeHostViteSession(server);
assert(closing);
assert.strictEqual(closeHostViteSession(server),closing);
const flatten=e=>[e,...(e instanceof AggregateError?e.errors.flatMap(flatten):[])];
try {await assert.rejects(closing,error=>flatten(error).some(e=>e.message==='OWNED_CLOSE_FAILED'))}
finally {await server.close();connectionOpen=false}
console.log('BORROWED_CONNECTION_RELEASED');
`,
			],
			{
				cwd: resolve(import.meta.dirname, '..'),
				env: { ...process.env, NODE_ENV: 'development' },
				timeout: 15000,
			},
		)
		expect(stdout).toContain('HOST_DRAINED')
		expect(stdout.indexOf('HOST_DRAINED')).toBeLessThan(
			stdout.indexOf('BORROWED_CONNECTION_RELEASED'),
		)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}, 20000)
