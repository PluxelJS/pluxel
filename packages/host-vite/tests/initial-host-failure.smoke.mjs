import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const cli = join(dirname(fileURLToPath(import.meta.resolve('vite/package.json'))), 'bin/vite.js')
const host = new URL('../dist/index.mjs', import.meta.url).href
for (const stage of ['service', 'application']) {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-initial-host-failure-'))
	try {
		const prepare = `effects.defer(() => console.log('RESOURCE_DRAINED')); throw Object.assign(new Error('Unsupported vault snapshot version.'), {code:'INVALID_FORMAT'})`
		await writeFile(
			join(root, 'app.mjs'),
			stage === 'service'
				? `export default () => ({plugins:[],services:[{name:'vault',capabilities:[],prepare({effects}){${prepare}}}]})`
				: `export default () => ({plugins:[],prepare({host}){const effects=host.ctx.effects;${prepare}}})`,
		)
		await writeFile(
			join(root, 'vite.config.mjs'),
			`import {host} from ${JSON.stringify(host)}; export default {plugins:host({entry:'app.mjs',devConsole:true})}`,
		)
		await assert.rejects(
			promisify(execFile)(
				process.execPath,
				[
					cli,
					root,
					'--config',
					join(root, 'vite.config.mjs'),
					'--host',
					'127.0.0.1',
					'--port',
					'0',
				],
				{
					env: { ...process.env, NODE_ENV: 'development' },
					timeout: 15000,
				},
			),
			(error) => {
				assert.equal(error.code, 1)
				assert.match(error.stderr, /Unsupported vault snapshot version/)
				assert.match(error.stdout, /RESOURCE_DRAINED/)
				assert.doesNotMatch(error.stdout, /ready in|Local:/)
				return true
			},
		)
		console.log('INITIAL_HOST_FAILURE_OK', stage)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
}
