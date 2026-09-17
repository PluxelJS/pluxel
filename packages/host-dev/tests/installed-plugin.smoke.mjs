// Built-artifact boundary: run after building Host, Host-dev, Host-dynamic and Rolldown.
import { mkdtemp, writeFile, mkdir, symlink, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire, stripTypeScriptTypes } from 'node:module'
import { pathToFileURL, fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
const clientSource = await readFile(new URL('../../cli/src/dev/client.ts', import.meta.url), 'utf8')
const { discoverDevInstances, runDevFile, selectDevInstance } = await import(
	'data:text/javascript;base64,' +
		Buffer.from(stripTypeScriptTypes(clientSource, { mode: 'transform' })).toString('base64')
)
const workspace = fileURLToPath(new URL('../../../', import.meta.url))
const require = createRequire(join(workspace, 'packages/host-dev/package.json'))
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
const { host } = await import(
	pathToFileURL(join(workspace, 'packages/host-dev/dist/vite.mjs')).href
)
const { httpDevelopment } = await import(
	pathToFileURL(join(workspace, 'packages/host-dev/dist/http.mjs')).href
)
const root = await mkdtemp(join(tmpdir(), 'pluxel-installed-host-'))
await mkdir(join(root, 'node_modules/@test/installed'), { recursive: true })
await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
await symlink(
	join(workspace, 'packages/host-dynamic'),
	join(root, 'node_modules/@pluxel/host-dynamic'),
	'dir',
)
await symlink(
	join(workspace, 'packages/services'),
	join(root, 'node_modules/@pluxel/services'),
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
	`import {BasePlugin,Plugin} from '@pluxel/core';import {Http} from '@pluxel/services/http';import {__setPluginDefinition,PLUGIN_LOWERING_ABI_VERSION} from '@pluxel/core/toolchain';export class Installed extends BasePlugin {init(){this.ctx.require(Http).get('/installed/${value}',()=> '${value}');globalThis.__installedHostSmoke.push('${value}');this.ctx.effects.defer(()=>{globalThis.__installedHostSmoke.push('-${value}')})}}Plugin()(Installed);__setPluginDefinition(Installed,{abiVersion:PLUGIN_LOWERING_ABI_VERSION,kind:'plugin',definition:${JSON.stringify(identity)}});`
await writeFile(join(root, 'node_modules/@test/installed/index.mjs'), installed('one'))
await writeFile(join(root, 'fixed.mjs'), installed('fixed', fixedDefinition))
const serviceSource = (
	revision,
	fail = false,
) => `import {http} from '@pluxel/services/http';import {defineContextCapability,installRootCapability} from '@pluxel/core/host';
const token=defineContextCapability('fixture.service');
export const services=[http(),{name:'fixture.service',capabilities:[installRootCapability(token,{create:()=>({revision:'${revision}'})})],async prepare({effects}){await Promise.resolve();globalThis.__installedHostSmoke.push('service:${revision}');effects.defer(()=>globalThis.__installedHostSmoke.push('-service:${revision}'));${fail ? "throw new Error('service preparation rejected')" : ''}}}];`
await writeFile(join(root, 'services.mjs'), serviceSource('one'))
await writeFile(
	join(root, 'app.ts'),
	`import {services} from './services.mjs';import {Installed} from './fixed.mjs';import {dynamicSource} from '@pluxel/host-dynamic';export default {services,plugins:[Installed],sources:[dynamicSource({kind:'directory',path:'./entries',include:['*.mjs']})],state:{initial:{autoStart:[{definition:${JSON.stringify(fixedDefinition)},variant:'default'},{definition:${JSON.stringify(definition)},variant:'default'}]}}};`,
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
		plugins: [host({ entry: 'app.ts', devConsole: true }), httpDevelopment()],
	})
	await server.listen()
	await until(() => globalThis.__installedHostSmoke.includes('fixed'), 'fixed plugin startup')
	const listener = server.resolvedUrls.local[0]
	const response = await fetch(new URL('/installed/fixed', listener))
	assert.equal(await response.text(), 'fixed')
	const instance = await selectDevInstance({ root })
	const consoleFile = join(root, 'inspect.ts')
	await writeFile(
		consoleFile,
		'export default async (dev) => (await dev.plugins.list()).map(plugin => plugin.address.definition.exportName)',
	)
	const inspect = () =>
		runDevFile({
			root,
			instance: instance.instanceId,
			file: consoleFile,
			exportName: 'default',
			timeoutMs: 5000,
			detach: false,
		})
	const initial = await inspect()
	assert.equal(initial.state, 'succeeded', JSON.stringify(initial))
	assert.ok(initial.value.includes('Installed'))
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
	await writeFile(join(root, 'services.mjs'), serviceSource('failed', true))
	await until(
		() => globalThis.__installedHostSmoke.filter((entry) => entry === 'fixed').length === 2,
		'service preparation compensation',
	)
	// Separate two physical edits beyond Chokidar's same-path change throttle.
	// Host settlement remains observed through the lifecycle predicates below.
	await delay(200)
	await writeFile(join(root, 'services.mjs'), serviceSource('two'))
	await until(
		() => globalThis.__installedHostSmoke.filter((entry) => entry === 'fixed').length === 3,
		'service host replacement',
	)
	const updatedResponse = await fetch(new URL('/installed/fixed', listener))
	assert.equal(await updatedResponse.text(), 'fixed')
	const replaced = await inspect()
	assert.equal(replaced.state, 'succeeded', JSON.stringify(replaced))
	assert.notEqual(replaced.hostEpoch, initial.hostEpoch)
	await server.close()
	server = undefined
	assert.deepEqual(await discoverDevInstances(root), [])
	const expected = [
		'service:one',
		'fixed',
		'one',
		'-one',
		'two',
		'-two',
		'-fixed',
		'-service:one',
		'service:failed',
		'-service:failed',
		'service:one',
		'fixed',
		'-fixed',
		'-service:one',
		'service:two',
		'fixed',
		'-fixed',
		'-service:two',
	]
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
