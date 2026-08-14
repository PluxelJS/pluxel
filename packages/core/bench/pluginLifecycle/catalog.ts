type Area =
	| 'graph build/verify'
	| 'dependents traversal'
	| 'lifecycle restart'
	| 'config injection'
	| 'noop/overhead'

export const TASK = {
	coldStar: 'cold: build star graph',
	coldChain: 'cold: build chain graph',
	coldLarge: 'cold: build large graph',
	noopStar: 'commit: no pending op (star)',
	addLeafStar: 'incremental: add leaf (star)',
	restartLeafStar: 'restart: leaf (star)',
	restartRootStar: 'restart: root (star)',
	replaceLeafStar: 'hmr: replace leaf (star)',
	replaceRootStar: 'hmr: replace root (star)',
	unregisterLeafStar: 'unregister: leaf cascade (star)',
	unregisterRootStar: 'unregister: root cascade (star)',
	restartChainMiddle: 'restart: chain middle',
	restartChainLeaf: 'restart: chain leaf',
	unregisterChainMiddle: 'unregister: chain middle cascade',
	configRestart: 'config: inject-heavy restart',
	noopLarge: 'large: no pending op',
	addLeafLarge: 'large: add leaf',
	replaceLeafLarge: 'large: replace leaf',
	replaceRootLarge: 'large: replace root',
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
}

const task = (area: Area, focus: string): TaskMetadata => ({ area, focus })

export const TASK_METADATA: Record<TaskName, TaskMetadata> = {
	[TASK.coldStar]: task('graph build/verify', 'star build + verify'),
	[TASK.coldChain]: task('graph build/verify', 'chain topo + verify'),
	[TASK.coldLarge]: task('graph build/verify', 'large build + verify'),
	[TASK.noopStar]: task('noop/overhead', 'commit early exit'),
	[TASK.addLeafStar]: task('graph build/verify', 'small structural diff'),
	[TASK.restartLeafStar]: task('lifecycle restart', 'single restart'),
	[TASK.restartRootStar]: task('dependents traversal', 'broad restart cascade'),
	[TASK.replaceLeafStar]: task('graph build/verify', 'leaf HMR'),
	[TASK.replaceRootStar]: task('dependents traversal', 'root HMR cascade'),
	[TASK.unregisterLeafStar]: task('dependents traversal', 'leaf unregister'),
	[TASK.unregisterRootStar]: task('dependents traversal', 'root unregister cascade'),
	[TASK.restartChainMiddle]: task('dependents traversal', 'deep restart cascade'),
	[TASK.restartChainLeaf]: task('lifecycle restart', 'deep leaf restart'),
	[TASK.unregisterChainMiddle]: task('dependents traversal', 'deep unregister cascade'),
	[TASK.configRestart]: task('config injection', 'config field injection'),
	[TASK.noopLarge]: task('noop/overhead', 'large commit early exit'),
	[TASK.addLeafLarge]: task('graph build/verify', 'large small-diff tax'),
	[TASK.replaceLeafLarge]: task('graph build/verify', 'large leaf HMR tax'),
	[TASK.replaceRootLarge]: task('dependents traversal', 'large root HMR cascade'),
}

export const DECISION_SIGNALS = [
	{
		name: 'large graph tax: add leaf',
		numerator: TASK.addLeafLarge,
		denominator: TASK.addLeafStar,
		watchAt: 1.5,
		focus: 'keep small diffs local',
	},
	{
		name: 'large graph tax: leaf HMR',
		numerator: TASK.replaceLeafLarge,
		denominator: TASK.replaceLeafStar,
		watchAt: 1.5,
		focus: 'keep leaf HMR local',
	},
	{
		name: 'cascade tax: root HMR',
		numerator: TASK.replaceRootStar,
		denominator: TASK.replaceLeafStar,
		watchAt: 4,
		focus: 'trim restart cascade',
	},
	{
		name: 'cascade tax: root unregister',
		numerator: TASK.unregisterRootStar,
		denominator: TASK.unregisterLeafStar,
		watchAt: 4,
		focus: 'trim unregister cascade',
	},
	{
		name: 'cascade tax: chain middle restart',
		numerator: TASK.restartChainMiddle,
		denominator: TASK.restartChainLeaf,
		watchAt: 4,
		focus: 'trim deep traversal',
	},
	{
		name: 'config injection tax',
		numerator: TASK.configRestart,
		denominator: TASK.restartLeafStar,
		watchAt: 2,
		focus: 'trim config injection',
	},
] as const
