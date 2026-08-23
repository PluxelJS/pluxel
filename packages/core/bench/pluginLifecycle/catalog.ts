type Area =
	| 'graph build/verify'
	| 'dependents traversal'
	| 'lifecycle restart'
	| 'config injection'
	| 'noop/overhead'

export const WORKLOAD_ID = 'core-runtime-transactions-v2'

export const TASK = {
	coldStar: 'cold: build star graph',
	coldChain: 'cold: build chain graph',
	coldLarge: 'cold: build large graph',
	noopStar: 'transaction: empty commit (star)',
	addLeafStar: 'incremental: add leaf (star)',
	restartLeafStar: 'restart: leaf (star)',
	restartRootStar: 'restart: root (star)',
	replaceLeafStar: 'replace definition: leaf (star)',
	replaceRootStar: 'replace definition: root (star)',
	unregisterLeafStar: 'unregister: leaf cascade (star)',
	unregisterRootStar: 'unregister: root cascade (star)',
	restartChainMiddle: 'restart: chain middle',
	restartChainLeaf: 'restart: chain leaf',
	unregisterChainMiddle: 'unregister: chain middle cascade',
	configRestart: 'config: cached object restart',
	noopLarge: 'transaction: empty commit (large)',
	addLeafLarge: 'large: add leaf',
	replaceLeafLarge: 'large: replace leaf definition',
	replaceRootLarge: 'large: replace root definition',
} as const

export type TaskName = (typeof TASK)[keyof typeof TASK]

export const TASK_NAMES = Object.freeze(Object.values(TASK)) as readonly TaskName[]

export function selectTaskNames(raw: string | undefined): readonly TaskName[] {
	if (!raw?.trim()) return TASK_NAMES

	const requested = new Set(
		raw
			.split(',')
			.map((name) => name.trim())
			.filter(Boolean),
	)
	if (requested.size === 0) {
		throw new Error('PLUXEL_BENCH_TASKS did not contain a task name')
	}
	const known = new Set<string>(TASK_NAMES)
	const unknown = [...requested].filter((name) => !known.has(name))
	if (unknown.length > 0) {
		throw new Error(
			`Unknown PLUXEL_BENCH_TASKS: ${unknown.join(', ')}. Valid tasks: ${TASK_NAMES.join(', ')}`,
		)
	}
	return TASK_NAMES.filter((name) => requested.has(name))
}

export type TaskMetadata = {
	area: Area
	focus: string
	regressionGate: 'enabled' | 'diagnostic'
}

const task = (
	area: Area,
	focus: string,
	regressionGate: TaskMetadata['regressionGate'] = 'enabled',
): TaskMetadata => ({ area, focus, regressionGate })

export const TASK_METADATA: Record<TaskName, TaskMetadata> = {
	[TASK.coldStar]: task('graph build/verify', 'star build + verify'),
	[TASK.coldChain]: task('graph build/verify', 'chain topo + verify'),
	[TASK.coldLarge]: task('graph build/verify', 'large build + verify'),
	[TASK.noopStar]: task('noop/overhead', 'empty transaction early exit', 'diagnostic'),
	[TASK.addLeafStar]: task('graph build/verify', 'small structural diff'),
	[TASK.restartLeafStar]: task('lifecycle restart', 'single restart'),
	[TASK.restartRootStar]: task('dependents traversal', 'broad restart cascade'),
	[TASK.replaceLeafStar]: task('graph build/verify', 'leaf definition replacement'),
	[TASK.replaceRootStar]: task('dependents traversal', 'root definition replacement cascade'),
	[TASK.unregisterLeafStar]: task('dependents traversal', 'leaf unregister'),
	[TASK.unregisterRootStar]: task('dependents traversal', 'root unregister cascade'),
	[TASK.restartChainMiddle]: task('dependents traversal', 'deep restart cascade'),
	[TASK.restartChainLeaf]: task('lifecycle restart', 'deep leaf restart'),
	[TASK.unregisterChainMiddle]: task('dependents traversal', 'deep unregister cascade'),
	[TASK.configRestart]: task('config injection', 'cached object snapshot injection'),
	[TASK.noopLarge]: task(
		'noop/overhead',
		'empty transaction locality with disconnected background nodes',
		'diagnostic',
	),
	[TASK.addLeafLarge]: task('graph build/verify', 'large small-diff tax'),
	[TASK.replaceLeafLarge]: task('graph build/verify', 'large leaf replacement locality'),
	[TASK.replaceRootLarge]: task(
		'dependents traversal',
		'root replacement locality with disconnected background nodes',
	),
}

export const DECISION_SIGNALS = [
	{
		name: 'disconnected background tax: add leaf',
		numerator: TASK.addLeafLarge,
		denominator: TASK.addLeafStar,
		watchAt: 1.5,
		focus: 'keep small structural diffs independent of disconnected nodes',
	},
	{
		name: 'disconnected background tax: leaf definition replacement',
		numerator: TASK.replaceLeafLarge,
		denominator: TASK.replaceLeafStar,
		watchAt: 1.5,
		focus: 'keep leaf replacement independent of disconnected nodes',
	},
	{
		name: 'disconnected background tax: root definition replacement',
		numerator: TASK.replaceRootLarge,
		denominator: TASK.replaceRootStar,
		watchAt: 1.5,
		focus: 'keep a fixed dependent cascade independent of disconnected nodes',
	},
	{
		name: 'disconnected background tax: empty transaction',
		numerator: TASK.noopLarge,
		denominator: TASK.noopStar,
		watchAt: 1.5,
		focus: 'keep empty transaction commit independent of graph size',
	},
	{
		name: 'cached object config injection tax',
		numerator: TASK.configRestart,
		denominator: TASK.restartLeafStar,
		watchAt: 2,
		focus: 'keep cached object injection close to an ordinary restart',
	},
] as const
