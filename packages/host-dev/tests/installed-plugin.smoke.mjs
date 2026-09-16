// Built-artifact boundary: run after building Host, Host-dev, Host-dynamic and Rolldown.
import { mkdtemp, writeFile, mkdir, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(join(workspace, 'packages/host-dev/package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
const { host } = await import(
	pathToFileURL(join(workspace, 'packages/host-dev/dist/vite.mjs')).href
)
const root = await mkdtemp(join(tmpdir(), 'pluxel-installed-host-'))
await mkdir(join(root, 'node_modules/@test/installed'), { recursive: true })
await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
await symlink(
	join(workspace, 'packages/host-dynamic'),
	join(root, 'node_modules/@pluxel/host-dynamic'),
	'dir',
)
await mkdir(join(root, 'entries'))
await writeFile(
	join(root, 'package.json'),
	JSON.stringify({ name: '@test/installed-host-smoke', type: 'module' }),
)
await writeFile(
	join(root, 'node_modules/@test/installed/package.json'),
	JSON.stringify({ name: '@test/installed', type: 'module', exports: './index.mjs' }),
)
const definition = {
	entry: { kind: 'package-root', packageName: '@test/installed' },
	exportName: 'Installed',
}
const fixedDefinition = {
	entry: { kind: 'package-root', packageName: '@test/fixed' },
	exportName: 'Installed',
}
const installed = (value, identity = definition) =>
	`import {BasePlugin,Plugin} from '@pluxel/core';import {__setPluginDefinition,PLUGIN_LOWERING_ABI_VERSION} from '@pluxel/core/toolchain';export class Installed extends BasePlugin {init(){globalThis.__installedHostSmoke.push('${value}');this.ctx.effects.defer(()=>{globalThis.__installedHostSmoke.push('-${value}')})}}Plugin()(Installed);__setPluginDefinition(Installed,{abiVersion:PLUGIN_LOWERING_ABI_VERSION,kind:'plugin',definition:${JSON.stringify(identity)}});`
await writeFile(join(root, 'node_modules/@test/installed/index.mjs'), installed('one'))
await writeFile(join(root, 'fixed.mjs'), installed('fixed', fixedDefinition))
await writeFile(
	join(root, 'app.ts'),
	`import {Installed} from './fixed.mjs';import {dynamicSource} from '@pluxel/host-dynamic';export default {plugins:[Installed],sources:[dynamicSource({kind:'directory',path:'./entries',include:['*.mjs']})],state:{autoStart:[{definition:${JSON.stringify(fixedDefinition)},variant:'default'},{definition:${JSON.stringify(definition)},variant:'default'}]}};`,
)
globalThis.__installedHostSmoke = []
let server
async function until(check, label) {
	const deadline = Date.now() + 10000
	while (!check()) {
		if (Date.now() > deadline)
			throw new Error(label + ' ' + JSON.stringify(globalThis.__installedHostSmoke))
		await delay(25)
	}
}
try {
	server = await createServer({
		root,
		configFile: false,
		customLogger: {
			hasWarned: false,
			info() {},
			warn() {},
			warnOnce() {},
			error() {},
			clearScreen() {},
			hasErrorLogged() {
				return false
			},
		},
		server: { port: 0, host: '127.0.0.1' },
		plugins: host({ entry: 'app.ts' }),
	})
	await server.listen()
	await until(() => globalThis.__installedHostSmoke.includes('fixed'), 'fixed plugin startup')
	await writeFile(
		join(root, 'entries/installed.mjs'),
		`export {Installed} from '@test/installed'; // revision one\n`,
	)
	await until(() => globalThis.__installedHostSmoke.includes('one'), 'install')
	await writeFile(join(root, 'node_modules/@test/installed/index.mjs'), installed('two'))
	await writeFile(
		join(root, 'entries/installed.mjs'),
		`export {Installed} from '@test/installed'; // revision two\n`,
	)
	await until(() => globalThis.__installedHostSmoke.includes('two'), 'upgrade')
	await rm(join(root, 'entries/installed.mjs'))
	await until(() => globalThis.__installedHostSmoke.includes('-two'), 'uninstall')
	await server.close()
	server = undefined
	const expected = ['fixed', 'one', '-one', 'two', '-two', '-fixed']
	assert.deepEqual(
		globalThis.__installedHostSmoke,
		expected,
		'each revision must have exactly one lifecycle admission',
	)
	console.log('INSTALLED_PLUGIN_UPGRADE_SMOKE_OK', JSON.stringify(globalThis.__installedHostSmoke))
} finally {
	await server?.close()
	await rm(root, { recursive: true, force: true })
}
