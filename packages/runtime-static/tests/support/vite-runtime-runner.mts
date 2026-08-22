import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import type { PluginConstructor } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import type { StaticRuntimeHost } from '@pluxel/runtime-static'
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import { createServer, normalizePath, type HmrContext, type Plugin as VitePlugin } from 'vite'

const root = requiredEnv('PLUXEL_VITE_SMOKE_ROOT')
const entryPath = requiredEnv('PLUXEL_VITE_SMOKE_ENTRY')
const pluginPath = requiredEnv('PLUXEL_VITE_SMOKE_PLUGIN')
const cacheDir = requiredEnv('PLUXEL_VITE_SMOKE_CACHE')

let host: StaticRuntimeHost | undefined
let startupImplementation: PluginConstructor | undefined
const plugins = staticRuntimeVitePlugin({
	entry: entryPath,
	bindings: {
		capture(value: unknown, implementation: unknown) {
			host = value as StaticRuntimeHost
			startupImplementation = implementation as PluginConstructor
		},
	},
})
const routeEntry = plugins.at(-1)
if (!routeEntry || typeof routeEntry !== 'object' || Array.isArray(routeEntry)) {
	throw new Error('static Vite route plugin is missing')
}
const routePlugin = routeEntry as VitePlugin
const server = await createServer({
	configFile: false,
	root,
	cacheDir,
	logLevel: 'silent',
	optimizeDeps: { noDiscovery: true, include: [] },
	plugins: [
		...plugins,
		{
			name: 'test:disable-watch',
			enforce: 'post',
			config: () => ({ server: { watch: null } }),
		},
	],
	server: { middlewareMode: true },
})

const capturedHost = host
assert.ok(capturedHost, 'static host was not captured')
const address = capturedHost.describeCatalog().plugins[0]?.address
assert.ok(address, 'startup catalog is empty')
assert.deepEqual(address.definition.entry, {
	kind: 'package-root',
	packageName: '@fixture/vite-static',
})
const east = { definition: address.definition, variant: 'fork' as const, forkId: 'east' }
const west = { definition: address.definition, variant: 'fork' as const, forkId: 'west' }
const pluginService = requirePluginService(capturedHost.ctx)

try {
	const startupInstances = [address, east, west].map((node) => pluginService.getInstance(node))
	assert.deepEqual(
		startupInstances.map((instance) => Reflect.get(instance ?? {}, 'version')),
		['v1', 'v1', 'v1'],
	)
	for (const instance of startupInstances) {
		assert.equal(instance?.constructor, startupImplementation)
	}

	await writeFile(pluginPath, pluginSource('v2', true))
	await invokeHotUpdate(routePlugin, pluginPath)
	assert.deepEqual(capturedHost.lastReport()?.replaced, [address])
	const replacementInstances = [address, east, west].map((node) => pluginService.getInstance(node))
	assert.deepEqual(
		replacementInstances.map((instance) => Reflect.get(instance ?? {}, 'version')),
		['v2', 'v2', 'v2'],
	)
	const replacementImplementation = replacementInstances[0]?.constructor
	assert.notEqual(replacementImplementation, startupImplementation)
	for (const instance of replacementInstances) {
		assert.equal(instance?.constructor, replacementImplementation)
	}

	await writeFile(pluginPath, pluginSource('removed', false))
	await invokeHotUpdate(routePlugin, pluginPath)
	const removed = capturedHost.lastReport()
	assert.deepEqual(removed?.removed, [address])
	assert.ok(removed?.commit)
	assert.equal(Object.isFrozen(removed.commit), true)
	assert.equal('graph' in removed.commit, false)
	assert.equal(removed?.entries.filter((entry) => entry.status === 'catalog-drift').length, 1)
	assert.equal(removed?.entries.filter((entry) => entry.status === 'unavailable').length, 2)
	assert.equal(
		removed?.entries.some((entry) => entry.status === 'start-failed'),
		false,
	)
	assert.deepEqual(
		[address, east, west].map((node) => pluginService.getInstance(node)),
		[undefined, undefined, undefined],
	)

	await writeFile(pluginPath, pluginSource('v3', true))
	await invokeHotUpdate(routePlugin, pluginPath)
	assert.equal(pluginService.isRunning(address), true)
} finally {
	await server.close()
}
assert.equal(pluginService.isRunning(address), false)

async function invokeHotUpdate(route: VitePlugin, changedFile: string): Promise<void> {
	const hook = route.handleHotUpdate
	if (typeof hook !== 'function') throw new Error('static Vite hot-update hook is missing')
	await hook.call(route, {
		file: normalizePath(changedFile),
		server,
		modules: [],
		read: () => Promise.resolve(''),
		timestamp: Date.now(),
	} satisfies HmrContext)
}

function requiredEnv(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`missing ${name}`)
	return value
}

function pluginSource(version: string, available: boolean): string {
	return [
		"import { BasePlugin, Plugin } from '@pluxel/runtime'",
		"@Plugin({ displayName: 'Vite static', forkable: true })",
		'export class ViteStatic extends BasePlugin {',
		`  readonly version = ${JSON.stringify(version)}`,
		'}',
		`export const runtimePlugins = ${available ? '[ViteStatic]' : '[]'}`,
		'',
	].join('\n')
}
