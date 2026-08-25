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
const address = capturedHost
	.describeCatalog()
	.plugins.find((plugin) => plugin.address.definition.exportName === 'ViteStatic')?.address
assert.ok(address, 'startup catalog is empty')
const configuredAddress = capturedHost
	.describeCatalog()
	.plugins.find((plugin) => plugin.address.definition.exportName === 'ConfiguredPlugin')?.address
assert.ok(configuredAddress, 'configured plugin is absent from the startup catalog')
const partOwnerAddress = capturedHost
	.describeCatalog()
	.plugins.find((plugin) => plugin.address.definition.exportName === 'PartOwner')?.address
assert.ok(partOwnerAddress, 'Part owner is absent from the startup catalog')
assert.deepEqual(address.definition.entry, {
	kind: 'package-root',
	packageName: '@fixture/vite-static',
})
const east = { definition: address.definition, variant: 'fork' as const, forkId: 'east' }
const west = { definition: address.definition, variant: 'fork' as const, forkId: 'west' }
const pluginService = requirePluginService(capturedHost.ctx)

try {
	const startupInstances = [address, east, west].map((node) => pluginService.getInstance(node))
	assert.ok(startupInstances[0], JSON.stringify(capturedHost.lastReport()))
	assert.deepEqual(
		startupInstances.map((instance) => Reflect.get(instance ?? {}, 'version')),
		['v1', 'v1', 'v1'],
	)
	assert.equal(
		Reflect.get(pluginService.getInstance(configuredAddress) ?? {}, 'configuredLabel'),
		'configured-through-vite',
	)
	assert.equal(
		Reflect.get(pluginService.getInstance(partOwnerAddress) ?? {}, 'injected'),
		'part-provider-v1',
	)
	for (const instance of startupInstances) {
		assert.equal(instance?.constructor, startupImplementation)
	}

	await writeFile(pluginPath, pluginSource('v2', true))
	await invokeHotUpdate(routePlugin, pluginPath)
	assert.deepEqual(
		capturedHost
			.lastReport()
			?.replaced.map((node) => node.definition.exportName)
			.sort(),
		['ConfiguredPlugin', 'PartOwner', 'PartProvider', 'ViteStatic'],
	)
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
	assert.equal(
		Reflect.get(pluginService.getInstance(partOwnerAddress) ?? {}, 'injected'),
		'part-provider-v2',
	)

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
		"import { BasePlugin, Plugin, PluginPart, v } from '@pluxel/runtime'",
		"export const ViteStaticConfig = v.object({ label: v.optional(v.string(), 'default') })",
		"@Plugin({ displayName: 'Vite static', forkable: true })",
		'export class ViteStatic extends BasePlugin {',
		'  private readonly settings = this.configs.use(ViteStaticConfig)',
		`  readonly version = ${JSON.stringify(version)}`,
		"  configuredLabel = ''",
		'  protected override init() { this.configuredLabel = this.settings.label }',
		'}',
		"export const ConfiguredPluginConfig = v.object({ label: v.optional(v.string(), 'default') })",
		'@Plugin()',
		'export class ConfiguredPlugin extends BasePlugin {',
		'  private readonly settings = this.configs.use(ConfiguredPluginConfig)',
		"  configuredLabel = ''",
		'  protected override init() { this.configuredLabel = this.settings.label }',
		'}',
		'@Plugin()',
		'export class PartProvider extends BasePlugin {',
		`  readonly marker = ${JSON.stringify(`part-provider-${version}`)}`,
		'}',
		'class RequiredPart extends PluginPart<PartOwner> {',
		'  constructor(private readonly provider: PartProvider) { super() }',
		'  marker() { return this.provider.marker }',
		'}',
		'@Plugin()',
		'export class PartOwner extends BasePlugin {',
		'  private readonly required = this.parts.use(RequiredPart)',
		"  injected = ''",
		'  protected override init() { this.injected = this.required.marker() }',
		'}',
		`export const runtimePlugins = ${available ? '[ViteStatic, ConfiguredPlugin, PartProvider, PartOwner]' : '[ConfiguredPlugin, PartProvider, PartOwner]'}`,
		'',
	].join('\n')
}
