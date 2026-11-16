// Run after building Core, Host and Services:
// vp exec node packages/services/bench/management-status.bench.mjs
import { deepStrictEqual, equal } from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { BasePlugin, Plugin } from '../../core/dist/index.mjs'
import { __setPluginDefinition, PLUGIN_LOWERING_ABI_VERSION } from '../../core/dist/toolchain.mjs'
import { requirePluginHostCoordinator } from '../../host/dist/internal.mjs'
import { createServiceInternalTestHarness } from '../dist/internal/test.mjs'
import { RuntimeManagementTargetImpl } from '../dist/management/internal/test.mjs'

// oxlint-disable-next-line pluxel/plugin-base-class-requires-plugin-registration -- Native Node runs no decorator transform; the Plugin marker is registered explicitly below.
class StatusProvider extends BasePlugin {}
Plugin({ displayName: 'Provider', forkable: true })(StatusProvider)
__setPluginDefinition(StatusProvider, {
	abiVersion: PLUGIN_LOWERING_ABI_VERSION,
	kind: 'plugin',
	definition: {
		entry: { kind: 'source-entry', sourceSpace: 'bench', path: 'management-status.mjs' },
		exportName: 'StatusProvider',
	},
})

const samples = 20
const warmupCalls = 5
const repeatsPerSample = 100

async function countInventoryIterators(view, read) {
	let calls = 0
	const restore = []
	for (const map of [view.sessionIntents, view.desiredControl]) {
		const descriptor = Object.getOwnPropertyDescriptor(map, 'values')
		const original = map.values
		Object.defineProperty(map, 'values', {
			configurable: true,
			value() {
				calls++
				return Reflect.apply(original, this, [])
			},
		})
		restore.push(() => {
			if (descriptor) Object.defineProperty(map, 'values', descriptor)
			else delete map.values
		})
	}
	try {
		return { value: await read(), iteratorCalls: calls }
	} finally {
		for (const undo of restore) undo()
	}
}

async function measure(read) {
	for (let index = 0; index < warmupCalls; index++) await read()
	const times = []
	for (let sample = 0; sample < samples; sample++) {
		const started = performance.now()
		for (let index = 0; index < repeatsPerSample; index++) await read()
		times.push((performance.now() - started) / repeatsPerSample)
	}
	const sorted = times.toSorted((left, right) => left - right)
	return {
		meanMs: times.reduce((sum, value) => sum + value, 0) / samples,
		medianMs: (sorted[9] + sorted[10]) / 2,
	}
}

process.stdout.write(
	`${JSON.stringify({
		node: process.version,
		measurement:
			'native Management pluginStatusDto; coordinator/Core reads and DTO validation included; RPC transport excluded',
		warmupCalls,
		samples,
		repeatsPerSample,
		iteratorMetric:
			'sessionIntents.values plus desiredControl.values calls during display inventory; counted outside timing',
		allocationMetric:
			'no heap allocation claim; inventory iterator calls are a scan regression signal',
	})}\n`,
)

for (const forkCount of [8, 1_000, 10_000]) {
	const definition = StatusProvider.definitionAddress()
	const forks = Array.from({ length: forkCount }, (_, index) => ({
		definition,
		variant: 'fork',
		forkId: `stopped-${index}`,
	}))
	await using host = await createServiceInternalTestHarness({
		services: [],
		workbench: false,
		policy: { forks },
	})
	host.add(StatusProvider)
	await host.commit()
	const target = new RuntimeManagementTargetImpl(host.ctx)
	const address = forks.at(-1)
	const view = await requirePluginHostCoordinator(host.ctx).readCommitted((value) => value)
	const read = async () => {
		const response = await target.pluginStatusDto(address)
		if (response.ok !== true || response.value?.lifecycleState !== 'stopped') {
			throw new Error('Management exact status lost the selected stopped fork')
		}
		return response.value
	}
	const cold = await countInventoryIterators(view, read)
	const warm = await countInventoryIterators(view, read)
	deepStrictEqual(cold.value.address, address)
	deepStrictEqual(warm.value, cold.value)
	equal(cold.iteratorCalls, 2)
	equal(warm.iteratorCalls, 0)
	const timing = await measure(read)
	deepStrictEqual(await read(), cold.value)
	process.stdout.write(
		`${JSON.stringify({
			forks: forkCount,
			coldDirectoryIteratorCalls: cold.iteratorCalls,
			warmDirectoryIteratorCalls: warm.iteratorCalls,
			warmExactDto: timing,
		})}\n`,
	)
}
