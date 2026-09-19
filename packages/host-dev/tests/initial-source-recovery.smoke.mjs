// Built-artifact regression: initial dynamic failures have no committed watcher or Plugin catalog.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { host } from '../dist/vite.mjs'

const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
const { createServer } = await import(require.resolve('vite'))
async function runScenario(scenario) {
	const root = await mkdtemp(join(tmpdir(), 'pluxel-initial-source-'))
	const errors = []
	const key = `__initialSourceRecovery_${process.pid}`
	let server
	async function until(check, label) {
		const deadline = Date.now() + 10000
		while (!check()) {
			if (Date.now() > deadline) throw new Error(`${label}: ${errors.join('; ')}`)
			await delay(25)
		}
	}
	try {
		await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
		await symlink(
			join(workspace, 'packages/host-dynamic'),
			join(root, 'node_modules/@pluxel/host-dynamic'),
			'dir',
		)
		await writeFile(
			join(root, 'package.json'),
			JSON.stringify({ name: 'initial-source-fixture', type: 'module' }),
		)
		await writeFile(
			join(root, 'app.ts'),
			`import {dynamicSource} from '@pluxel/host-dynamic';
export default {plugins:[],sources:[dynamicSource({kind:'directory',path:'./entries',include:['*.entry.mjs']})],prepare(){globalThis[${JSON.stringify(key)}]=(globalThis[${JSON.stringify(key)}]??0)+1}}`,
		)
		await mkdir(join(root, 'entries'))
		const source = join(root, 'entries/broken.entry.mjs')
		await writeFile(
			source,
			scenario === 'syntax' ? 'export const invalid = ;' : "import './missing.mjs'; export {}",
		)
		server = await createServer({
			root,
			configFile: false,
			server: { port: 0, host: '127.0.0.1' },
			plugins: host({ entry: 'app.ts' }),
			customLogger: {
				hasWarned: false,
				info() {},
				warn() {},
				warnOnce() {},
				clearScreen() {},
				hasErrorLogged() {
					return false
				},
				error(message, details) {
					errors.push(details?.error?.stack ?? message)
				},
			},
		})
		await server.listen()
		assert.equal(globalThis[key], undefined)
		assert.ok(errors.length > 0)
		if (scenario === 'syntax') await writeFile(source, 'export {}')
		else await writeFile(join(root, 'entries/missing.mjs'), 'export {}')
		await until(
			() => globalThis[key] === 1,
			`${scenario} repair must recover initial dynamic source`,
		)
		await server.close()
		server = undefined
		assert.equal(globalThis[key], 1)
		console.log('INITIAL_SOURCE_RECOVERY_SMOKE_OK', scenario)
	} finally {
		await server?.close()
		delete globalThis[key]
		await rm(root, { recursive: true, force: true })
	}
}
for (const scenario of ['syntax', 'missing-import']) await runScenario(scenario)
