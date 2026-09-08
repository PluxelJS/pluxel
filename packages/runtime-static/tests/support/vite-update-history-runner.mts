import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pluginNodeAddressEqual } from '@pluxel/core'
import { readRuntimePluginStatusOverview } from '@pluxel/runtime/internal'
import type { StaticRuntimeHost } from '@pluxel/runtime-static'
import { staticRuntimeVitePlugin } from '@pluxel/runtime-static/vite'
import { createServer, normalizePath, type HotUpdateOptions, type Plugin } from 'vite'

const root = process.argv[2]
assert.ok(root)
const entry = resolve(root, 'pluxel.static.ts')
const source = (fail: boolean) => `import { pluginNodeAddressOf } from '@pluxel/runtime'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { Service, Healthy } from './plugin.ts'
export default defineStaticRuntime({
	name: 'update-history', plugins: [Service, Healthy],
	configure() {
		const base = pluginNodeAddressOf(Service)
		const east = { definition: base.definition, variant: 'fork', forkId: 'east' }
		const west = { definition: base.definition, variant: 'fork', forkId: 'west' }
		return { workbench: false, logging: false,
			configService: { mode: 'memory', snapshot: { plugins: [{ owner: east, config: { fail: ${fail} } }] } },
			runtimeState: { mode: 'memory', snapshot: { autoStart: [base, east, west, pluginNodeAddressOf(Healthy)], forks: [{ definition: base.definition, forkIds: ['east', 'west'] }] } }
		}
	},
	prepare({ host, startup }) { startup.bindings.capture(host) }
})`
await writeFile(entry, source(false))
let host: StaticRuntimeHost | undefined
const plugins = staticRuntimeVitePlugin({
	entry,
	bindings: {
		capture(value: unknown) {
			host = value as StaticRuntimeHost
		},
	},
})
const route = plugins.at(-1) as Plugin
const server = await createServer({
	configFile: false,
	root,
	cacheDir: resolve(root, '.vite'),
	plugins,
	logLevel: 'silent',
	optimizeDeps: { noDiscovery: true, include: [] },
	server: { host: '127.0.0.1', port: 0 },
})
try {
	await server.listen()
	await server.watcher.close()
	const first = host
	assert.ok(first)
	const initial = await readRuntimePluginStatusOverview(first.ctx)
	assert.equal(initial.statuses.filter((status) => status.lifecycleState === 'running').length, 4)
	const service = initial.statuses.find(
		(status) =>
			status.address.definition.exportName === 'Service' && status.address.variant === 'default',
	)
	assert.ok(service)
	const east = { definition: service.address.definition, variant: 'fork' as const, forkId: 'east' }
	await reload(true)
	const partialHost = host
	assert.ok(partialHost)
	assert.notEqual(partialHost, first)
	const partial = await readRuntimePluginStatusOverview(partialHost.ctx)
	const failure = partial.statuses.find((status) => pluginNodeAddressEqual(status.address, east))
	assert.equal(failure?.lifecycleState, 'stopped')
	assert.equal(failure?.recentUpdate?.batch.scope, 'application')
	assert.equal(failure?.recentUpdate?.batch.outcome, 'applied-with-issues')
	assert.equal(failure?.recentUpdate?.lifecycle?.issues[0]?.message, 'east startup failed')
	for (const status of partial.statuses.filter(
		(candidate) => !pluginNodeAddressEqual(candidate.address, east),
	)) {
		assert.equal(status.lifecycleState, 'running')
		assert.deepEqual(status.recentUpdate?.lifecycle, { issues: [] })
		assert.equal(status.recentUpdate?.batch.sequence, failure?.recentUpdate?.batch.sequence)
	}
	await reload(false)
	assert.ok(host)
	const recovered = await readRuntimePluginStatusOverview(host.ctx)
	for (const status of recovered.statuses) {
		assert.equal(status.lifecycleState, 'running')
		assert.equal(status.recentUpdate?.batch.outcome, 'applied')
		assert.deepEqual(status.recentUpdate?.lifecycle, { issues: [] })
	}
} finally {
	await server.close()
}

async function reload(fail: boolean): Promise<void> {
	await writeFile(entry, source(fail))
	const hook = route.hotUpdate
	assert.ok(hook)
	const invoke = typeof hook === 'function' ? hook : hook.handler
	await invoke.call(
		{ environment: server.environments.ssr } as never,
		{
			type: 'update',
			file: normalizePath(entry),
			timestamp: Date.now(),
			modules: [],
			read: () => readFile(entry, 'utf8'),
			server,
		} as HotUpdateOptions,
	)
}
