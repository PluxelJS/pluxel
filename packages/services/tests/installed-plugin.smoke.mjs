// Built-artifact boundary: run after building Host, Host-dev and Rolldown.
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
const { vitePreset } = await import(
	pathToFileURL(join(workspace, 'packages/services/dist/vite.mjs')).href
)
const { readHostRecentUpdates } = await import(
	pathToFileURL(join(workspace, 'packages/host/dist/internal.mjs')).href
)
const root = await mkdtemp(join(tmpdir(), 'pluxel-installed-host-'))
await mkdir(join(root, 'node_modules/@test/installed'), { recursive: true })
await mkdir(join(root, 'node_modules/@pluxel'), { recursive: true })
await symlink(join(workspace, 'packages/host'), join(root, 'node_modules/@pluxel/host'), 'dir')
await symlink(
	join(workspace, 'packages/services'),
	join(root, 'node_modules/@pluxel/services'),
	'dir',
)
await mkdir(join(root, 'entries'))
const typedRoot = join(root, 'packages/typed')
await mkdir(join(typedRoot, 'src'), { recursive: true })
await symlink(typedRoot, join(root, 'node_modules/@test/typed'), 'dir')
await writeFile(
	join(typedRoot, 'package.json'),
	JSON.stringify({
		name: '@test/typed',
		type: 'module',
		exports: { '.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' } },
	}),
)
await writeFile(join(typedRoot, 'src/version.ts'), "export const version: string = 'ts-one'\n")
await writeFile(
	join(typedRoot, 'src/index.ts'),
	`
import { BasePlugin, Plugin } from '@pluxel/core'
import { Http } from '@pluxel/services/http'
import { version } from './version'
@Plugin()
export class Typed extends BasePlugin {
 init() {
  this.ctx.require(Http).get('/typed', () => version)
  globalThis.__typedHostSmoke.push(version)
  this.ctx.effects.defer(() => { globalThis.__typedHostSmoke.push('-' + version) })
 }
}
`,
)
const typedDefinition = {
	entry: { kind: 'package-root', packageName: '@test/typed' },
	exportName: 'Typed',
}

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
	`import {BasePlugin,Plugin} from '@pluxel/core';import {Http} from '@pluxel/services/http';import {__setPluginDefinition} from '@pluxel/core/toolchain';export class Installed extends BasePlugin {init(){this.ctx.require(Http).get('/installed/${value}',()=> '${value}');globalThis.__installedHostSmoke.push('${value}');this.ctx.effects.defer(()=>{globalThis.__installedHostSmoke.push('-${value}')})}}Plugin()(Installed);__setPluginDefinition(Installed,{abiVersion:2,kind:'plugin',definition:${JSON.stringify(identity)}});`
await writeFile(join(root, 'node_modules/@test/installed/index.mjs'), installed('one'))
await writeFile(join(root, 'fixed.mjs'), installed('fixed', fixedDefinition))
const serviceSource = (
	revision,
	fail = false,
) => `import {http,HttpServer} from '@pluxel/services/http';import {defineContextCapability,installRootCapability,resolveContextCapability} from '@pluxel/core/host';
const token=defineContextCapability('fixture.service');
export const services=[http(),{name:'fixture.service',capabilities:[installRootCapability(token,{create:()=>({revision:'${revision}'})})],async prepare({effects,ctx}){effects.defer(resolveContextCapability(ctx,HttpServer).mountFallback({matchesRequest:r=>new URL(r.url).pathname==='/native-copy',fetch:async r=>new Response(await new Request(r).text())}));globalThis.__installedHostSmokeContext=ctx;await Promise.resolve();globalThis.__installedHostSmoke.push('service:${revision}');effects.defer(()=>globalThis.__installedHostSmoke.push('-service:${revision}'));${fail ? "throw new Error('service preparation rejected')" : ''}}}];`
await writeFile(join(root, 'services.mjs'), serviceSource('one'))
await writeFile(
	join(root, 'app.ts'),
	`import {defineHostApplication} from '@pluxel/host';import {services} from './services.mjs';import {Installed} from './fixed.mjs';import {dynamicSource} from '@pluxel/host/dynamic';export default defineHostApplication(() => ({services,plugins:[Installed],sources:[dynamicSource({kind:'directory',path:'./entries',include:['*.mjs','*.ts']}),{key:'diagnostic-probe',covers:()=>false,async open(options){globalThis.__installedHostSmokeSourceError=options.onError;return {entries:[],async close(){}}}}],state:{initial:{autoStart:[{definition:${JSON.stringify(fixedDefinition)},variant:'default'},{definition:${JSON.stringify(definition)},variant:'default'},{definition:${JSON.stringify(typedDefinition)},variant:'default'}]}}}));`,
)
globalThis.__installedHostSmoke = []
globalThis.__typedHostSmoke = []
let server
async function until(check, label) {
	const deadline = Date.now() + 10000
	while (!check()) {
		if (Date.now() > deadline)
			throw new Error(
				label +
					' ' +
					JSON.stringify({
						installed: globalThis.__installedHostSmoke,
						typed: globalThis.__typedHostSmoke,
					}),
			)
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
		plugins: [vitePreset({ entry: 'app.ts', devConsole: true })],
	})
	await server.listen()
	await until(() => globalThis.__installedHostSmoke.includes('fixed'), 'fixed plugin startup')
	const listener = server.resolvedUrls.local[0]
	const response = await fetch(new URL('/installed/fixed', listener))
	assert.equal(await response.text(), 'fixed')
	// A native Request copy must also work beyond the business Elysia dispatcher.
	const fallback = await fetch(new URL('/native-copy', listener), {
		method: 'POST',
		body: 'native-body',
	})
	assert.equal(fallback.status, 200)
	assert.equal(await fallback.text(), 'native-body')
	const instance = await selectDevInstance({ root })
	const consoleFile = join(root, 'inspect.ts')
	await writeFile(consoleFile, 'export default async (dev) => await dev.plugins.list()')
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
	assert.ok(initial.value.some((plugin) => plugin.address.definition.exportName === 'Installed'))
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
	const upgraded = await inspect()
	assert.equal(upgraded.state, 'succeeded', JSON.stringify(upgraded))
	const upgradedPlugin = upgraded.value.find(
		(plugin) => plugin.address.definition.entry.packageName === '@test/installed',
	)
	assert.equal(upgradedPlugin.recentUpdate.batch.outcome, 'applied')
	assert.equal(upgradedPlugin.recentUpdate.batch.scope, 'definitions')
	assert.deepEqual(upgradedPlugin.execution, {
		kind: 'dynamic-entry',
		artifact: { kind: 'built-module' },
		update: { kind: 'definition-hmr', scope: 'entry-only' },
	})
	const latestUpdate = () =>
		readHostRecentUpdates(globalThis.__installedHostSmokeContext)?.latestUpdate()
	const beforeWatcherFailure = latestUpdate()
	globalThis.__installedHostSmokeSourceError(new Error('source watcher failed'))
	await until(
		() => latestUpdate()?.sequence > beforeWatcherFailure.sequence,
		'source watcher failure published',
	)
	assert.equal(latestUpdate().outcome, 'retained-previous')
	assert.equal(latestUpdate().phase, 'evaluate')
	assert.match(latestUpdate().error.message, /source watcher failed/)
	const watcherFailure = await inspect()
	assert.equal(watcherFailure.state, 'succeeded', JSON.stringify(watcherFailure))
	assert.deepEqual(
		watcherFailure.value.find(
			(plugin) => plugin.address.definition.entry.packageName === '@test/installed',
		).recentUpdate,
		upgradedPlugin.recentUpdate,
		'watcher failure must not rewrite individual Plugin lifecycle history',
	)
	const watcherRetainedResponse = await fetch(new URL('/installed/two', listener))
	assert.equal(await watcherRetainedResponse.text(), 'two')
	const watcherSequence = latestUpdate().sequence
	await writeFile(join(root, 'entries/installed.mjs'), 'export const invalid = ;\n')
	await until(
		() =>
			latestUpdate()?.sequence > watcherSequence && latestUpdate()?.outcome === 'retained-previous',
		'failed candidate retained previous catalog',
	)
	const failedAttempt = latestUpdate()
	assert.equal(failedAttempt.phase, 'evaluate')
	assert.ok(failedAttempt.error)
	const retainedResponse = await fetch(new URL('/installed/two', listener))
	assert.equal(await retainedResponse.text(), 'two')
	const retained = await inspect()
	assert.equal(retained.state, 'succeeded', JSON.stringify(retained))
	const retainedPlugin = retained.value.find(
		(plugin) => plugin.address.definition.entry.packageName === '@test/installed',
	)
	assert.deepEqual(
		retainedPlugin.recentUpdate,
		upgradedPlugin.recentUpdate,
		'an unresolvable candidate must not overwrite the old node history',
	)
	await delay(200)
	await writeFile(
		join(root, 'entries/installed.mjs'),
		`export {Installed} from '@test/installed'; // recovered\n`,
	)
	await until(
		() => latestUpdate()?.outcome === 'applied' && latestUpdate().sequence > failedAttempt.sequence,
		'failed candidate recovery',
	)
	const stoppedBeforeRemoval = globalThis.__installedHostSmoke.filter(
		(entry) => entry === '-two',
	).length
	await rm(join(root, 'entries/installed.mjs'))
	await until(
		() =>
			globalThis.__installedHostSmoke.filter((entry) => entry === '-two').length >
			stoppedBeforeRemoval,
		'uninstall',
	)
	// Discover a new TypeScript entry after startup, then invalidate its imported source graph.
	await writeFile(join(root, 'entries/typed.ts'), "export { Typed } from '@test/typed'\n")
	await until(() => globalThis.__typedHostSmoke.includes('ts-one'), 'new TypeScript entry')
	const typedFirstResponse = await fetch(new URL('/typed', listener))
	assert.equal(await typedFirstResponse.text(), 'ts-one')
	await writeFile(join(typedRoot, 'src/version.ts'), "export const version: string = 'ts-two'\n")
	await until(() => globalThis.__typedHostSmoke.includes('ts-two'), 'TypeScript dependency HMR')
	const typedUpdatedResponse = await fetch(new URL('/typed', listener))
	assert.equal(await typedUpdatedResponse.text(), 'ts-two')
	const typedInspection = await inspect()
	assert.equal(typedInspection.state, 'succeeded', JSON.stringify(typedInspection))
	assert.equal(typedInspection.hostEpoch, initial.hostEpoch, 'Plugin HMR keeps the Host')
	const typedPlugin = typedInspection.value.find(
		(plugin) => plugin.address.definition.entry.packageName === '@test/typed',
	)
	assert.deepEqual(typedPlugin.execution, {
		kind: 'dynamic-entry',
		artifact: { kind: 'source-module' },
		update: { kind: 'definition-hmr', scope: 'source-graph' },
	})
	await rm(join(root, 'entries/typed.ts'))
	await until(() => globalThis.__typedHostSmoke.includes('-ts-two'), 'TypeScript entry removal')
	const typedRemovedResponse = await fetch(new URL('/typed', listener))
	assert.equal(typedRemovedResponse.status, 404)
	const removedTyped = await inspect()
	assert.equal(removedTyped.state, 'succeeded', JSON.stringify(removedTyped))
	const withdrawn = removedTyped.value.find(
		(plugin) => plugin.address.definition.entry.packageName === '@test/typed',
	)
	assert.equal(withdrawn.availability, 'unavailable')
	assert.equal(withdrawn.lifecycleState, 'stopped')
	assert.equal(withdrawn.autoStart, true, 'withdrawal preserves the configured startup intent')
	assert.deepEqual(globalThis.__typedHostSmoke, ['ts-one', '-ts-one', 'ts-two', '-ts-two'])
	await writeFile(join(root, 'services.mjs'), serviceSource('failed', true))
	await until(
		() => globalThis.__installedHostSmoke.filter((entry) => entry === 'fixed').length === 2,
		'service preparation compensation',
	)
	const compensated = await inspect()
	assert.equal(compensated.state, 'succeeded', JSON.stringify(compensated))
	const compensatedPlugin = compensated.value.find(
		(plugin) => plugin.address.definition.entry.packageName === '@test/fixed',
	)
	assert.equal(compensatedPlugin.recentUpdate.batch.outcome, 'restored-previous')
	assert.equal(compensatedPlugin.recentUpdate.batch.phase, 'application-reload')
	assert.ok(
		compensatedPlugin.recentUpdate.batch.sequence > upgradedPlugin.recentUpdate.batch.sequence,
	)
	const compensatedResponse = await fetch(new URL('/installed/fixed', listener))
	assert.equal(await compensatedResponse.text(), 'fixed')
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
	const restoredPlugin = replaced.value.find(
		(plugin) => plugin.address.definition.entry.packageName === '@test/fixed',
	)
	assert.equal(restoredPlugin.recentUpdate.batch.outcome, 'applied')
	assert.equal(restoredPlugin.recentUpdate.batch.scope, 'application')
	assert.ok(
		restoredPlugin.recentUpdate.batch.sequence > compensatedPlugin.recentUpdate.batch.sequence,
	)
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
