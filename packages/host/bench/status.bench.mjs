// Run from the workspace after building Core and Host:
// mise exec -- node packages/host/bench/status.bench.mjs
import { deepStrictEqual } from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { pluginNodeAddressEqual } from '../../core/dist/index.mjs'
import {
	createPluginCatalogSnapshot,
	hostPluginStatusFromView,
	hostPluginStatusOverviewFromView,
} from '../dist/internal.mjs'

const definition = Object.freeze({
	entry: Object.freeze({ kind: 'package-root', packageName: '@bench/status' }),
	exportName: 'Provider',
})
const candidate = {
	implementation: class Provider {},
	declaration: {
		address: definition,
		displayName: 'Provider',
		requires: [],
		optional: [],
		parts: [],
		forkable: true,
	},
}
const samples = 20
const warmupCalls = 5

function summarize(times, repeatsPerSample) {
	const sorted = times.toSorted((left, right) => left - right)
	return {
		meanMs: times.reduce((sum, time) => sum + time, 0) / times.length,
		medianMs: (sorted[9] + sorted[10]) / 2,
		samples,
		repeatsPerSample,
	}
}

function measure(run, repeats) {
	for (let index = 0; index < warmupCalls; index++) run()
	const times = []
	for (let sample = 0; sample < samples; sample++) {
		const started = performance.now()
		for (let index = 0; index < repeats; index++) run()
		times.push((performance.now() - started) / repeats)
	}
	return summarize(times, repeats)
}

function measureColdExact(view, target) {
	// A new published state identity has no WeakMap index. Its immutable arrays and
	// the fixture view are prepared before timing; state publication itself is excluded.
	const prepare = () => ({ ...view, state: Object.freeze({ ...view.state }) })
	for (let index = 0; index < warmupCalls; index++) hostPluginStatusFromView(prepare(), target)
	const times = []
	for (let sample = 0; sample < samples; sample++) {
		const coldView = prepare()
		const started = performance.now()
		const status = hostPluginStatusFromView(coldView, target)
		times.push(performance.now() - started)
		if (!status || !pluginNodeAddressEqual(status.address, target))
			throw new Error('Cold lookup lost target status')
	}
	return summarize(times, 1)
}

function countProjectionWork(view, target) {
	let projectedStatusObjects = 0
	const tracked = {
		...view,
		recentUpdate: {
			resolveRecentUpdate() {
				projectedStatusObjects++
				return null
			},
		},
	}
	const originalSort = Array.prototype.sort
	let sorts = 0
	try {
		// oxlint-disable-next-line no-extend-native -- Count native sort calls outside timing; restore in finally.
		Array.prototype.sort = function (...args) {
			sorts++
			return Reflect.apply(originalSort, this, args)
		}
		hostPluginStatusOverviewFromView(tracked)
		const overview = { projectedStatusObjects, sorts }
		projectedStatusObjects = sorts = 0
		hostPluginStatusFromView(tracked, target)
		return { overview, exact: { projectedStatusObjects, sorts } }
	} finally {
		// oxlint-disable-next-line no-extend-native -- Restore native sort after the untimed call count.
		Array.prototype.sort = originalSort
	}
}

process.stdout.write(
	`${JSON.stringify({
		node: process.version,
		measurement: 'committed-view status projection; coordinator/Core graph reads and RPC excluded',
		warmupCalls,
		samples,
		allocationMetric:
			'projected status object count; excludes other objects and is not net heap allocation',
	})}\n`,
)

for (const [size, repeats] of [
	[8, 500],
	[1_000, 5],
	[10_000, 1],
]) {
	const forks = Object.freeze(
		Array.from({ length: size }, (_, index) =>
			Object.freeze({
				definition,
				variant: 'fork',
				forkId: `node-${index}`,
			}),
		),
	)
	const target = forks.at(-1)
	const view = {
		catalog: createPluginCatalogSnapshot(1, [{ candidate }]),
		state: Object.freeze({
			autoStart: Object.freeze([]),
			forks,
			providerDefaults: Object.freeze([]),
			dependencyOverrides: Object.freeze([]),
		}),
		reconciliation: [],
		sessionIntents: new Map(),
		desiredControl: new Map(),
		coreNodes: [],
		runningNodeKeys: new Set(),
		recentUpdate: undefined,
	}
	const findStatus = () =>
		hostPluginStatusOverviewFromView(view).statuses.find((entry) =>
			pluginNodeAddressEqual(entry.address, target),
		)
	deepStrictEqual(hostPluginStatusFromView(view, target), findStatus())
	const overview = measure(() => {
		if (!findStatus()) throw new Error('Overview lost target status')
	}, repeats)
	const exact = measure(() => {
		const status = hostPluginStatusFromView(view, target)
		if (!status || !pluginNodeAddressEqual(status.address, target))
			throw new Error('Exact lookup lost target status')
	}, 2_000)
	const counts = countProjectionWork(view, target)
	process.stdout.write(
		`${JSON.stringify({
			forks: size,
			warmOverview: { ...overview, ...counts.overview },
			warmExact: { ...exact, ...counts.exact },
			coldExact: measureColdExact(view, target),
		})}\n`,
	)
}
