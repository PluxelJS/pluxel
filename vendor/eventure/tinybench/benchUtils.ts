import { appendFile } from 'node:fs/promises'
import { arch, cpus, platform } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Bench, Task, TaskResultWithStatistics } from 'tinybench'

export type CompletedResult = TaskResultWithStatistics & {
	state: 'completed' | 'aborted-with-statistics'
}

export const readBenchTime = () => {
	const value = Number(process.env.BENCH_TIME_MS ?? 1000)
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error('BENCH_TIME_MS must be a positive finite number')
	}
	return value
}

export const readImportArgs = (scriptName: string) => {
	const args = process.argv.slice(2)
	if (args.length > 2) {
		throw new Error(`Usage: bun ${scriptName} [import | base target]`)
	}
	return args as [] | [string] | [string, string]
}

export const resolveImport = (specifier: string, baseDir = process.cwd()) =>
	pathToFileURL(resolve(baseDir, specifier)).href

export const resultWithStatistics = (task: Task): CompletedResult => {
	const { result } = task
	if (
		result.state !== 'completed' &&
		result.state !== 'aborted-with-statistics'
	) {
		throw new Error(`Benchmark task "${task.name}" ended as ${result.state}`)
	}
	return result
}

export const renderPercent = (value: number | null | undefined) =>
	value === null || value === undefined
		? '-'
		: `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`

export const renderNumber = (value: number) => value.toFixed(2)

export const renderRuntime = (bench: Bench) =>
	`${bench.runtime} ${bench.runtimeVersion}, ${platform()}/${arch()}, ${cpus()[0]?.model ?? 'unknown'}, timer ${bench.timestampProvider.name}`

export const writeGitHubMarkdown = async (markdown: string) => {
	if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
		await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`, 'utf8')
	}

	if (process.env.GITHUB_OUTPUT === undefined) return

	let delimiter = 'BENCHMARK_MARKDOWN'
	while (markdown.includes(delimiter)) {
		delimiter = `${delimiter}_END`
	}
	await appendFile(
		process.env.GITHUB_OUTPUT,
		`markdown<<${delimiter}\n${markdown}\n${delimiter}\n`,
		'utf8',
	)
}
