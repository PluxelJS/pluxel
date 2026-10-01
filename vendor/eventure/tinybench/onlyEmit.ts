import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import EventEmitter2 from 'eventemitter2'
import EventEmitter3 from 'eventemitter3'
import mitt from 'mitt'
import { Bench, formatNumber } from 'tinybench'

import {
	readBenchTime,
	readImportArgs,
	renderNumber,
	renderPercent,
	renderRuntime,
	resolveImport,
	resultWithStatistics,
	writeGitHubMarkdown,
	type CompletedResult,
} from './benchUtils'
import pkg from './package.json'

const NAME = 'Eventure'
const EVENT = 'ping'
const PAYLOAD = { msg: 'hello' }
const RUNS = 100_000
const LISTENERS = 2
const EXPECTED_COUNT = RUNS * LISTENERS * PAYLOAD.msg.length
const TIME_MS = readBenchTime()
const ASYNC_TIME_MS = TIME_MS * 2
const __dirname = dirname(fileURLToPath(import.meta.url))
const eventureImports = readImportArgs('./tinybench/onlyEmit.ts')

type Payload = typeof PAYLOAD
type Listener = (payload: Payload) => unknown
type Emitter = {
	on(event: typeof EVENT, listener: Listener): unknown
	emit(event: typeof EVENT, payload: Payload): unknown
}
type EventureConstructor = new (options?: {
	captureRejections?: boolean
	catchPromiseError?: boolean
	captureReturnedPromises?: boolean
	checkSyncFuncReturnPromise?: boolean
}) => Emitter
type Candidate = {
	label: string
	create: () => Emitter
}

const importEventure = async (specifier: string, baseDir?: string) => {
	const mod = (await import(resolveImport(specifier, baseDir))) as {
		Eventure: EventureConstructor
	}
	return mod.Eventure
}

const eventureOptions = {
	captureRejections: false,
	catchPromiseError: false,
	captureReturnedPromises: false,
	checkSyncFuncReturnPromise: false,
}

const eventureCandidates = await (async () => {
	if (eventureImports.length === 2) {
		const [baselineImport, targetImport] = eventureImports
		const [BaselineEventure, TargetEventure] = await Promise.all([
			importEventure(baselineImport),
			importEventure(targetImport),
		])
		return [
			{
				label: `${NAME} base`,
				create: () => new BaselineEventure(eventureOptions),
			},
			{
				label: `${NAME} PR`,
				create: () => new TargetEventure(eventureOptions),
			},
		] satisfies Candidate[]
	}

	const Eventure =
		eventureImports.length === 1
			? await importEventure(eventureImports[0])
			: await importEventure('../dist/index.mjs', __dirname)
	return [
		{
			label: NAME,
			create: () => new Eventure(eventureOptions),
		},
	] satisfies Candidate[]
})()

const pairedEventureCandidates =
	eventureCandidates.length === 2
		? [
				eventureCandidates[0]!,
				eventureCandidates[1]!,
				{
					...eventureCandidates[1]!,
					label: `${eventureCandidates[1]!.label} mirror`,
				},
				{
					...eventureCandidates[0]!,
					label: `${eventureCandidates[0]!.label} mirror`,
				},
			]
		: eventureCandidates

const controlCandidates = [
	{
		label: `EventEmitter3`,
		create: () => new EventEmitter3(),
	},
	{
		label: `EventEmitter2`,
		create: () => new EventEmitter2(),
	},
	{
		label: `mitt`,
		create: () => mitt<{ [EVENT]: Payload }>(),
	},
] satisfies Candidate[]

const candidates =
	eventureCandidates.length === 2
		? [
				pairedEventureCandidates[0]!,
				pairedEventureCandidates[1]!,
				...controlCandidates,
				pairedEventureCandidates[2]!,
				pairedEventureCandidates[3]!,
			]
		: [...eventureCandidates, ...controlCandidates]

let checksum = 0

const title = `${NAME} emit benchmark`
const referenceVersions = [
	`EventEmitter3 ${pkg.dependencies.eventemitter3}`,
	`EventEmitter2 ${pkg.dependencies.eventemitter2}`,
	`mitt ${pkg.dependencies.mitt}`,
].join(', ')
const toNs = (ms: number) => ms * 1_000_000
const x100kEmitsPerSecond = (result: CompletedResult) => result.throughput.mean
const emitsPerSecond = (result: CompletedResult) =>
	x100kEmitsPerSecond(result) * RUNS
const reportLabel = (taskName: string) =>
	taskName
		.replace(/ mirror(?= (?:sync|async)$)/, '')
		.replace(/ (?:sync|async)$/, '')

const assertCount = (label: string, count: number) => {
	if (count !== EXPECTED_COUNT) {
		throw new Error(`${label}: expected count ${EXPECTED_COUNT}, got ${count}`)
	}
	checksum += count
}

const createBench = (name: string, time: number) => {
	const bench = new Bench({
		name,
		time,
		iterations: 10,
		timestampProvider: 'hrtimeNow',
		throws: true,
		warmup: true,
		warmupIterations: 8,
		warmupTime: Math.min(250, time),
	})

	bench.addEventListener('cycle', (event) => {
		if (event.task !== undefined) {
			const result = resultWithStatistics(event.task)
			console.log(
				`${event.task.name}: ${formatNumber(emitsPerSecond(result))} emits/s, rme ${result.throughput.rme.toFixed(2)}%`,
			)
		}
	})

	return bench
}

const addSyncTasks = (bench: Bench) => {
	for (const candidate of candidates) {
		let emitter: Emitter
		let count = 0

		bench.add(
			`${candidate.label} sync`,
			() => {
				for (let i = 0; i < RUNS; i++) {
					emitter.emit(EVENT, PAYLOAD)
				}
			},
			{
				beforeAll() {
					emitter = candidate.create()
					emitter.on(EVENT, (data) => {
						count += data.msg.length
					})
					emitter.on(EVENT, (data) => {
						count += data.msg.length
					})
				},
				beforeEach() {
					count = 0
				},
				afterEach(mode) {
					if (mode === 'run') assertCount(candidate.label, count)
				},
			},
		)
	}
}

const addAsyncTasks = (bench: Bench) => {
	for (const candidate of candidates) {
		let emitter: Emitter
		let count = 0
		let pending = 0
		let done: Promise<void> | null = null
		let resolveDone: (() => void) | null = null

		bench.add(
			`${candidate.label} async`,
			async () => {
				for (let i = 0; i < RUNS; i++) {
					emitter.emit(EVENT, PAYLOAD)
				}
				await done
			},
			{
				async: true,
				beforeAll() {
					emitter = candidate.create()
					const onAsync = (data: Payload) => {
						pending++
						done ??= new Promise<void>((resolve) => {
							resolveDone = resolve
						})

						return Promise.resolve().then(() => {
							count += data.msg.length
							if (--pending === 0) {
								const resolve = resolveDone
								done = null
								resolveDone = null
								resolve?.()
							}
						})
					}

					emitter.on(EVENT, onAsync)
					emitter.on(EVENT, onAsync)
				},
				beforeEach() {
					count = 0
					pending = 0
					done = null
					resolveDone = null
				},
				afterEach(mode) {
					if (mode === 'run') assertCount(candidate.label, count)
				},
			},
		)
	}
}

const benchRows = (bench: Bench) => {
	return bench.tasks.map((task) => {
		const result = resultWithStatistics(task)
		const hz = emitsPerSecond(result)

		return {
			task,
			label: reportLabel(task.name),
			hz,
			rme: result.throughput.rme,
			samples: result.latency.samplesCount,
		}
	})
}

const reportRows = (rows: ReturnType<typeof benchRows>) => {
	const groups = new Map<string, typeof rows>()
	for (const row of rows) {
		const group = groups.get(row.label)
		if (group === undefined) {
			groups.set(row.label, [row])
		} else {
			group.push(row)
		}
	}

	const aggregated = [...groups.entries()].map(([label, group]) => ({
		label,
		hz: group.reduce((sum, row) => sum + row.hz, 0) / group.length,
		rme: Math.max(...group.map((row) => row.rme)),
		samples: group.reduce((sum, row) => sum + row.samples, 0),
	}))
	const sorted = [...aggregated].sort((a, b) => b.hz - a.hz)

	return aggregated.map((row) => ({
		...row,
		rank: sorted.findIndex((candidate) => candidate.label === row.label) + 1,
		relativeToFastest: row.hz / sorted[0]!.hz,
		latencyNs: 1_000_000_000 / row.hz,
	}))
}

const consoleRows = (bench: Bench) =>
	bench.table((task) => {
		const result = resultWithStatistics(task)
		const latencyMedian = result.latency.p50 ?? result.latency.mean

		return {
			Task: task.name,
			'Throughput avg (x10^5 emits/s)': `${x100kEmitsPerSecond(result).toFixed(2)} +/- ${result.throughput.rme.toFixed(2)}%`,
			'Latency avg (ns/emit)': `${(toNs(result.latency.mean) / RUNS).toFixed(2)} +/- ${result.latency.rme.toFixed(2)}%`,
			'Latency med (ns/emit)': (toNs(latencyMedian) / RUNS).toFixed(2),
			Samples: result.latency.samplesCount,
		}
	})

const runBench = async (bench: Bench) => {
	console.log(`=== ${bench.name} ===`)
	await bench.run()
	console.table(consoleRows(bench))
	return benchRows(bench)
}

const markdownTable = (rows: ReturnType<typeof benchRows>) => {
	const summarizedRows = reportRows(rows)
	const eventureBase = summarizedRows.find(
		(row) => row.label === `${NAME} base`,
	)
	const eventurePr = summarizedRows.find((row) => row.label === `${NAME} PR`)
	const pairedDelta =
		eventureBase !== undefined && eventurePr !== undefined
			? ((eventurePr.hz - eventureBase.hz) / eventureBase.hz) * 100
			: null
	const significant =
		pairedDelta !== null &&
		eventureBase !== undefined &&
		eventurePr !== undefined &&
		Math.abs(pairedDelta) > Math.max(eventureBase.rme + eventurePr.rme, 5)

	const lines = [
		'| Rank | Task | x10^5 emits/s | Eventure PR vs base | RME max | Samples | ns/emit from Hz | vs fastest |',
		'| --- | --- | --- | --- | --- | --- | --- | --- |',
	]

	for (const row of summarizedRows.slice().sort((a, b) => a.rank - b.rank)) {
		const deltaVsBase =
			eventureBase !== undefined && row.label === `${NAME} PR`
				? ((row.hz - eventureBase.hz) / eventureBase.hz) * 100
				: null
		lines.push(
			`| ${row.rank} | ${row.label} | ${renderNumber(row.hz / RUNS)} | ${renderPercent(deltaVsBase)} | ${row.rme.toFixed(2)}% | ${row.samples} | ${row.latencyNs.toFixed(2)} | ${renderPercent((row.relativeToFastest - 1) * 100)} |`,
		)
	}

	return {
		lines,
		pairedDelta,
		significant,
	}
}

const renderMarkdown = (
	syncRows: ReturnType<typeof benchRows>,
	asyncRows: ReturnType<typeof benchRows>,
	bench: Bench,
) => {
	const syncTable = markdownTable(syncRows)
	const asyncTable = markdownTable(asyncRows)
	const deltas = [
		['sync', syncTable.pairedDelta, syncTable.significant],
		['async', asyncTable.pairedDelta, asyncTable.significant],
	] as const
	const regressions = deltas.filter(
		([, delta, significant]) => significant && delta !== null && delta < 0,
	)
	const improvements = deltas.filter(
		([, delta, significant]) => significant && delta !== null && delta > 0,
	)

	return [
		'## Benchmark Performance',
		`Runtime: ${renderRuntime(bench)}`,
		`Event: \`${EVENT}\`, emits/sample: \`${RUNS}\`, listeners/emit: \`${LISTENERS}\`, payload bytes: \`${new TextEncoder().encode(JSON.stringify(PAYLOAD)).length}\`, checksum: \`${checksum}\``,
		`Reference libraries: ${referenceVersions}`,
		eventureCandidates.length === 2
			? 'Eventure base/PR rows aggregate mirrored task positions to reduce fixed-order bias.'
			: '',
		'',
		regressions.length === 0
			? '- No significant regressions detected.'
			: `- Significant regressions: ${regressions
					.map(([mode, delta]) => `**${mode}** ${renderPercent(delta)}`)
					.join(', ')}`,
		improvements.length === 0
			? '- No improvements above the noise threshold.'
			: `- Notable improvements: ${improvements
					.map(([mode, delta]) => `**${mode}** ${renderPercent(delta)}`)
					.join(', ')}`,
		'',
		'### Sync emit loop',
		...syncTable.lines,
		'',
		'### Async end-to-end',
		...asyncTable.lines,
		'',
	].join('\n')
}

const benchSync = createBench(`${title} - sync`, TIME_MS)
addSyncTasks(benchSync)
const syncRows = await runBench(benchSync)

const benchAsync = createBench(`${title} - async`, ASYNC_TIME_MS)
addAsyncTasks(benchAsync)
const asyncRows = await runBench(benchAsync)

const markdown = renderMarkdown(syncRows, asyncRows, benchSync)
console.log(markdown)

await writeGitHubMarkdown(markdown)
