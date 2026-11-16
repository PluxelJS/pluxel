// Run after building Core and Host: vp exec node packages/host/bench/discovery.bench.mjs
import { equal } from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { BasePlugin, Plugin } from '../../core/dist/index.mjs'
import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '../../core/dist/toolchain.mjs'
import { createHost } from '../dist/index.mjs'
import { createScriptScope } from '@pluxel/agent-sdk/host'

// oxlint-disable-next-line pluxel/plugin-base-class-requires-plugin-registration -- Native Node benchmark explicitly registers the lowered fixture below.
class DiscoveryProvider extends BasePlugin {}
Plugin({ forkable: true })(DiscoveryProvider)
__setPluginDefinition(DiscoveryProvider, {
	abiVersion: PLUGIN_LOWERING_ABI_VERSION,
	kind: 'plugin',
	definition: {
		entry: { kind: 'source-entry', sourceSpace: 'bench', path: 'discovery.bench.mjs' },
		exportName: 'DiscoveryProvider',
	},
})

for (const forkCount of [1_000, 10_000]) {
	await using host = await createHost({
		plugins: [DiscoveryProvider],
		policy: {
			forks: Array.from({ length: forkCount }, (_, index) =>
				DiscoveryProvider.nodeAddress(`fork-${index}`),
			),
		},
		runtime: { documents: { config: false, state: false } },
	})
	await host.start()
	await using scope = createScriptScope({ ctx: host.ctx })
	const times = []
	for (let sample = 0; sample < 3; sample++) {
		let cursor
		let count = 0
		const start = performance.now()
		do {
			const result = await scope.sdk.plugins.list({ limit: 50, cursor })
			const page = result.unwrap()
			count += page.nodes.length
			cursor = page.nextCursor ?? undefined
		} while (cursor !== undefined)
		equal(count, forkCount + 1)
		times.push(performance.now() - start)
	}
	process.stdout.write(`${JSON.stringify({ forkCount, pageSize: 50, traversalMs: times })}\n`)
}
