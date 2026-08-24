#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs'

const [basePath, legacyBridgePath, currentBridgePath, outputPath] = process.argv.slice(2)
if (!basePath || !legacyBridgePath || !currentBridgePath || !outputPath) {
	throw new Error(
		'Usage: core-bench-reference-bridge.mjs <base-v1.json> <bridge-v1.json> <bridge-v2.json> <output.json>',
	)
}

const readReport = (file) => JSON.parse(readFileSync(file, 'utf8'))
const base = readReport(basePath)
const legacyBridge = readReport(legacyBridgePath)
const currentBridge = readReport(currentBridgePath)

const runtimeIdentity = (report) => `${report.runtime?.name ?? ''}@${report.runtime?.version ?? ''}`
if (
	new Set([runtimeIdentity(base), runtimeIdentity(legacyBridge), runtimeIdentity(currentBridge)])
		.size !== 1
) {
	throw new Error('All workload bridge measurements must use the same runtime')
}

if (base.workload?.id || legacyBridge.workload?.id) {
	throw new Error('The workload bridge expects legacy reports without workload identities')
}
if (typeof currentBridge.workload?.id !== 'string') {
	throw new TypeError('The current bridge report is missing its workload identity')
}

const stableScenario = (report) => {
	const scenario = report.options?.scenario
	if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
		throw new TypeError('A workload bridge input is missing scenario options')
	}
	const { configKeys: _legacyConfigKeys, ...stable } = scenario
	return Object.fromEntries(
		Object.entries(stable).sort(([left], [right]) => left.localeCompare(right)),
	)
}

if (JSON.stringify(stableScenario(base)) !== JSON.stringify(stableScenario(legacyBridge))) {
	throw new Error('The base and legacy bridge scenarios differ')
}
if (JSON.stringify(stableScenario(base)) !== JSON.stringify(stableScenario(currentBridge))) {
	throw new Error('The legacy and current bridge scenarios differ')
}

const taskMappings = new Map([
	['cold: build star graph', 'cold: build star graph'],
	['cold: build chain graph', 'cold: build chain graph'],
	['cold: build large graph', 'cold: build large graph'],
	['commit: no pending op (star)', 'transaction: empty commit (star)'],
	['incremental: add leaf (star)', 'incremental: add leaf (star)'],
	['restart: leaf (star)', 'restart: leaf (star)'],
	['restart: root (star)', 'restart: root (star)'],
	['hmr: replace leaf (star)', 'replace definition: leaf (star)'],
	['hmr: replace root (star)', 'replace definition: root (star)'],
	['unregister: leaf cascade (star)', 'unregister: leaf cascade (star)'],
	['unregister: root cascade (star)', 'unregister: root cascade (star)'],
	['restart: chain middle', 'restart: chain middle'],
	['restart: chain leaf', 'restart: chain leaf'],
	['unregister: chain middle cascade', 'unregister: chain middle cascade'],
	['large: no pending op', 'transaction: empty commit (large)'],
	['large: add leaf', 'large: add leaf'],
	['large: replace leaf', 'large: replace leaf definition'],
	['large: replace root', 'large: replace root definition'],
])

const byName = (report) => new Map(report.tasks.map((task) => [task.name, task]))
const baseTasks = byName(base)
const legacyBridgeTasks = byName(legacyBridge)
const currentBridgeTasks = byName(currentBridge)
const round = (value, digits = 3) => Number(value.toFixed(digits))
const bridgeMetric = (baseValue, legacyBridgeValue, currentBridgeValue, digits = 3) => {
	if (![baseValue, legacyBridgeValue, currentBridgeValue].every(Number.isFinite)) return null
	if (legacyBridgeValue === 0) return null
	// Estimate the base under v2 by applying the v1->v2 conversion measured on one unchanged
	// runtime: base(v1) / bridge(v1) * bridge(v2).
	return round((baseValue / legacyBridgeValue) * currentBridgeValue, digits)
}
const combinedRme = (...values) => {
	if (!values.every(Number.isFinite)) return null
	return round(Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)), 2)
}

const tasks = []
for (const [legacyName, currentName] of taskMappings) {
	const baseTask = baseTasks.get(legacyName)
	const legacyBridgeTask = legacyBridgeTasks.get(legacyName)
	const currentBridgeTask = currentBridgeTasks.get(currentName)
	if (!baseTask || !legacyBridgeTask || !currentBridgeTask) continue

	const latencyMeanMs = bridgeMetric(
		baseTask.latencyMeanMs,
		legacyBridgeTask.latencyMeanMs,
		currentBridgeTask.latencyMeanMs,
	)
	const opsMean = bridgeMetric(
		baseTask.opsMean,
		legacyBridgeTask.opsMean,
		currentBridgeTask.opsMean,
	)
	if (latencyMeanMs == null || opsMean == null) continue

	tasks.push({
		name: currentName,
		runs: null,
		opsMean,
		opsRmePct:
			combinedRme(baseTask.opsRmePct, legacyBridgeTask.opsRmePct, currentBridgeTask.opsRmePct) ??
			Number.POSITIVE_INFINITY,
		latencyMeanMs,
		latencyP99Ms: bridgeMetric(
			baseTask.latencyP99Ms,
			legacyBridgeTask.latencyP99Ms,
			currentBridgeTask.latencyP99Ms,
		),
		latencyRmePct:
			combinedRme(
				baseTask.latencyRmePct,
				legacyBridgeTask.latencyRmePct,
				currentBridgeTask.latencyRmePct,
			) ?? Number.POSITIVE_INFINITY,
	})
}

if (tasks.length === 0) {
	throw new Error('The workload bridge found no tasks measured by all three reports')
}

writeFileSync(
	outputPath,
	JSON.stringify(
		{
			recordedAt: base.recordedAt,
			runtime: currentBridge.runtime,
			workload: currentBridge.workload,
			options: currentBridge.options,
			tasks,
			provenance: {
				method: 'chained-workload-bridge',
				description:
					'Base v1 was normalized through v1/v2 measurements on the same bridge runtime; uncertainty is combined conservatively.',
				baseRecordedAt: base.recordedAt ?? null,
				legacyBridgeRecordedAt: legacyBridge.recordedAt ?? null,
				currentBridgeRecordedAt: currentBridge.recordedAt ?? null,
				excludedTasks: ['config: cached object restart (workload semantics changed)'],
			},
		},
		null,
		2,
	),
)
