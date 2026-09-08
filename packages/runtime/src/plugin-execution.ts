/** Portable description of the artifact that supplied a Plugin definition. */
export type PluginArtifactSnapshot =
	| Readonly<{ kind: 'application-bundle' }>
	| Readonly<{ kind: 'source-module' }>
	| Readonly<{ kind: 'built-module' }>
	| Readonly<{ kind: 'unreported' }>

/**
 * Route-owned execution semantics for one Plugin definition.
 *
 * This is intentionally a closed union: artifact and update semantics are useful only when their
 * combination is known to be valid for the route that loaded the definition.
 */
export type PluginExecutionSnapshot =
	| Readonly<{
			kind: 'static-bundle'
			artifact: Readonly<{ kind: 'application-bundle' }>
			update: Readonly<{ kind: 'deployment' }>
	  }>
	| Readonly<{
			kind: 'static-catalog'
			artifact:
				| Readonly<{ kind: 'source-module' }>
				| Readonly<{ kind: 'built-module' }>
				| Readonly<{ kind: 'unreported' }>
			update: Readonly<{ kind: 'catalog-hmr' }> | Readonly<{ kind: 'manual' }>
	  }>
	| Readonly<{
			kind: 'dynamic-fixed'
			artifact:
				| Readonly<{ kind: 'source-module' }>
				| Readonly<{ kind: 'built-module' }>
				| Readonly<{ kind: 'unreported' }>
			update: Readonly<{ kind: 'host-reload' }>
	  }>
	| Readonly<{
			kind: 'dynamic-entry'
			artifact: Readonly<{ kind: 'source-module' }>
			update: Readonly<{ kind: 'definition-hmr'; scope: 'source-graph' }>
	  }>
	| Readonly<{
			kind: 'dynamic-entry'
			artifact: Readonly<{ kind: 'built-module' }> | Readonly<{ kind: 'unreported' }>
			update: Readonly<{ kind: 'definition-hmr'; scope: 'entry-only' }>
	  }>
	| Readonly<{
			kind: 'unreported'
			artifact: Readonly<{ kind: 'unreported' }>
			update: Readonly<{ kind: 'unreported' }>
	  }>

/** Transaction result shared by every definition participating in one route update. */
export type PluginUpdateBatchResult =
	| Readonly<{
			outcome: 'applied'
			phase: null
			sequence: number
			durationMs: number
	  }>
	| Readonly<{
			outcome: 'applied-with-issues'
			phase: 'lifecycle' | 'commit'
			sequence: number
			durationMs: number
	  }>
	| Readonly<{
			outcome: 'retained-previous'
			phase: 'evaluate' | 'artifacts' | 'inject' | 'commit'
			sequence: number
			durationMs: number
	  }>
	| Readonly<{
			outcome: 'restored-previous'
			phase: 'application-reload'
			sequence: number
			durationMs: number
	  }>

export type PluginUpdateBatchSnapshot = PluginUpdateBatchResult &
	Readonly<{
		/** Full application replacement or an in-host definition transaction. */
		scope: 'application' | 'definitions'
		/** Captured route failure; absent when the route supplied no diagnostic. */
		error?: RuntimeUpdateError
	}>

/** Portable, bounded diagnostic. Local stack traces stay in runtime logs. */
export type RuntimeUpdateError = Readonly<{
	message: string
	file: string | null
	importChain: readonly string[]
}>

/** The latest route attempt exists independently of the committed Plugin catalog. */
export type RuntimeUpdateSnapshot = Readonly<{ trigger: string | null }> &
	(
		| Readonly<{
				sequence: number
				state: 'updating'
				phase: 'evaluate' | 'artifacts' | 'inject' | 'commit' | 'lifecycle' | 'application-reload'
				outcome: null
				durationMs: number
				error: null
		  }>
		| (Readonly<{ state: 'settled'; error: RuntimeUpdateError | null }> & PluginUpdateBatchResult)
	)

export function cloneRuntimeUpdateError(input: unknown): RuntimeUpdateError {
	const value = exactRecord(input, ['message', 'file', 'importChain'], 'Runtime update error')
	if (typeof value.message !== 'string' || value.message.length > 4096)
		invalid('Invalid update error message')
	if (value.file !== null && (typeof value.file !== 'string' || value.file.length > 1024))
		invalid('Invalid update error file')
	if (
		!Array.isArray(value.importChain) ||
		value.importChain.length > 32 ||
		value.importChain.some((item) => typeof item !== 'string' || item.length > 1024)
	)
		invalid('Invalid update import chain')
	return Object.freeze({
		message: value.message as string,
		file: value.file as string | null,
		importChain: Object.freeze([...(value.importChain as string[])]),
	})
}

export function cloneRuntimeUpdateSnapshot(input: unknown): RuntimeUpdateSnapshot | null {
	if (input === null) return null
	const value = exactRecord(
		input,
		['sequence', 'state', 'phase', 'outcome', 'durationMs', 'trigger', 'error'],
		'Runtime update',
	)
	if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0)
		invalid('Invalid update sequence')
	if (
		typeof value.durationMs !== 'number' ||
		!Number.isFinite(value.durationMs) ||
		value.durationMs < 0
	)
		invalid('Invalid update duration')
	if (value.trigger !== null && (typeof value.trigger !== 'string' || value.trigger.length > 1024))
		invalid('Invalid update trigger')
	const state = oneOf(value.state, ['updating', 'settled'], 'Runtime update state')
	const phase =
		value.phase === null
			? null
			: oneOf(
					value.phase,
					['evaluate', 'artifacts', 'inject', 'commit', 'lifecycle', 'application-reload'],
					'Runtime update phase',
				)
	const outcome =
		value.outcome === null
			? null
			: oneOf(
					value.outcome,
					['applied', 'applied-with-issues', 'retained-previous', 'restored-previous'],
					'Runtime update outcome',
				)
	if ((state === 'updating') !== (outcome === null)) invalid('Invalid update state/outcome')
	if (state === 'updating' && (phase === null || value.error !== null))
		invalid('Updating attempts require a phase and no settled error')
	if (
		outcome === 'retained-previous' &&
		!['evaluate', 'artifacts', 'inject', 'commit'].includes(phase ?? '')
	)
		invalid('Invalid retained update phase')
	if (outcome === 'applied-with-issues' && !['commit', 'lifecycle'].includes(phase ?? ''))
		invalid('Invalid applied update phase')
	if (outcome === 'restored-previous' && phase !== 'application-reload')
		invalid('Invalid restored update phase')
	if (outcome === 'applied' && (phase !== null || value.error !== null))
		invalid('Applied updates cannot carry failures')
	return Object.freeze({
		sequence: value.sequence as number,
		state,
		phase,
		outcome,
		durationMs: value.durationMs as number,
		trigger: value.trigger as string | null,
		error: value.error === null ? null : cloneRuntimeUpdateError(value.error),
	}) as RuntimeUpdateSnapshot
}

/** Node-local historical facts, never inferred from the transaction's overall outcome. */
export type PluginUpdateLifecycleIssue = Readonly<{
	phase: 'resolve' | 'config' | 'start' | 'dependency' | 'drain'
	kind: 'resolve-failed' | 'config-failed' | 'start-failed' | 'dependency-blocked' | 'drain-failed'
	message: string
	blockedBy: string | null
}>

export type PluginRecentUpdateSnapshot = Readonly<{
	batch: PluginUpdateBatchSnapshot
	/** Null means no completed lifecycle report for this node in this batch. It does not mean success. */
	lifecycle: Readonly<{ issues: readonly PluginUpdateLifecycleIssue[] }> | null
}>

const UNREPORTED_ARTIFACT = Object.freeze({ kind: 'unreported' as const })
const UNREPORTED_UPDATE = Object.freeze({ kind: 'unreported' as const })

/** Shared immutable fallback when a route cannot report execution semantics. */
export const UNREPORTED_PLUGIN_EXECUTION: PluginExecutionSnapshot = Object.freeze({
	kind: 'unreported' as const,
	artifact: UNREPORTED_ARTIFACT,
	update: UNREPORTED_UPDATE,
})

/** Validate, detach, and deeply freeze one route-provided execution snapshot. */
export function clonePluginExecutionSnapshot(
	input: unknown,
	label = 'Plugin execution',
): PluginExecutionSnapshot {
	const value = exactRecord(input, ['kind', 'artifact', 'update'], label)
	const kind = oneOf(
		value.kind,
		['static-bundle', 'static-catalog', 'dynamic-fixed', 'dynamic-entry', 'unreported'],
		`${label}.kind`,
	)
	const artifact = artifactKind(value.artifact, `${label}.artifact`)
	const update = exactRecord(value.update, ['kind'], `${label}.update`, ['scope'])

	switch (kind) {
		case 'static-bundle':
			assertCombination(artifact === 'application-bundle', label)
			assertUpdateWithoutScope(update, 'deployment', label)
			return frozenExecution(kind, artifact, 'deployment')
		case 'static-catalog': {
			assertCombination(
				artifact === 'source-module' || artifact === 'built-module' || artifact === 'unreported',
				label,
			)
			const updateKind = oneOf(update.kind, ['catalog-hmr', 'manual'], `${label}.update.kind`)
			assertNoScope(update, label)
			return frozenExecution(kind, artifact, updateKind)
		}
		case 'dynamic-fixed':
			assertCombination(
				artifact === 'source-module' || artifact === 'built-module' || artifact === 'unreported',
				label,
			)
			assertUpdateWithoutScope(update, 'host-reload', label)
			return frozenExecution(kind, artifact, 'host-reload')
		case 'dynamic-entry': {
			if (update.kind !== 'definition-hmr') invalid(`${label}.update.kind must be definition-hmr`)
			const scope = oneOf(update.scope, ['source-graph', 'entry-only'], `${label}.update.scope`)
			assertCombination(
				(artifact === 'source-module' && scope === 'source-graph') ||
					((artifact === 'built-module' || artifact === 'unreported') && scope === 'entry-only'),
				label,
			)
			return Object.freeze({
				kind,
				artifact: Object.freeze({ kind: artifact }),
				update: Object.freeze({ kind: 'definition-hmr' as const, scope }),
			}) as PluginExecutionSnapshot
		}
		case 'unreported':
			assertCombination(artifact === 'unreported', label)
			assertUpdateWithoutScope(update, 'unreported', label)
			return UNREPORTED_PLUGIN_EXECUTION
	}
}

/** Validate, detach, and deeply freeze a route-provided recent-update snapshot. */
export function clonePluginUpdateBatchSnapshot(
	input: unknown,
	label = 'Plugin recent update',
): PluginUpdateBatchSnapshot {
	const value = exactRecord(input, ['scope', 'outcome', 'phase', 'sequence', 'durationMs'], label, [
		'error',
	])
	const outcome = oneOf(
		value.outcome,
		['applied', 'applied-with-issues', 'retained-previous', 'restored-previous'],
		`${label}.outcome`,
	)
	if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) <= 0) {
		invalid(`${label}.sequence must be a positive safe integer`)
	}
	if (
		typeof value.durationMs !== 'number' ||
		!Number.isFinite(value.durationMs) ||
		value.durationMs < 0
	) {
		invalid(`${label}.durationMs must be a finite non-negative number`)
	}
	const shared = {
		scope: oneOf(value.scope, ['application', 'definitions'], `${label}.scope`),
		sequence: value.sequence as number,
		durationMs: value.durationMs as number,
		...(value.error === undefined ? {} : { error: cloneRuntimeUpdateError(value.error) }),
	}
	if (outcome === 'applied') {
		if (value.error !== undefined) invalid(`${label}.error must be absent when outcome is applied`)
		if (value.phase !== null) invalid(`${label}.phase must be null when outcome is applied`)
		return Object.freeze({ outcome, phase: null, ...shared })
	}
	if (outcome === 'applied-with-issues') {
		const phase = oneOf(value.phase, ['lifecycle', 'commit'], `${label}.phase`)
		return Object.freeze({ outcome, phase, ...shared })
	}
	if (outcome === 'restored-previous') {
		if (shared.scope !== 'application')
			invalid(`${label}.scope must be application for compensation`)
		if (value.phase !== 'application-reload') {
			invalid(`${label}.phase must be application-reload when outcome is restored-previous`)
		}
		return Object.freeze({ outcome, phase: 'application-reload' as const, ...shared })
	}
	const phase = oneOf(value.phase, ['evaluate', 'artifacts', 'inject', 'commit'], `${label}.phase`)
	return Object.freeze({ outcome, phase, ...shared })
}

/** Validate the wire boundary without conflating batch outcome with node lifecycle health. */
export function clonePluginRecentUpdateSnapshot(
	input: unknown,
	label = 'Plugin recent update',
): PluginRecentUpdateSnapshot {
	const value = exactRecord(input, ['batch', 'lifecycle'], label)
	const batch = clonePluginUpdateBatchSnapshot(value.batch, `${label}.batch`)
	if (value.lifecycle === null) return Object.freeze({ batch, lifecycle: null })
	if (batch.outcome === 'retained-previous')
		invalid(`${label}.lifecycle must be null for a retained definition`)
	const lifecycle = exactRecord(value.lifecycle, ['issues'], `${label}.lifecycle`)
	if (!Array.isArray(lifecycle.issues)) invalid(`${label}.lifecycle.issues must be an array`)
	const issues = lifecycle.issues.map((issueInput: unknown) => {
		const issue = exactRecord(
			issueInput,
			['phase', 'kind', 'message', 'blockedBy'],
			`${label}.issue`,
		)
		const phase = oneOf(
			issue.phase,
			['resolve', 'config', 'start', 'dependency', 'drain'],
			`${label}.issue.phase`,
		)
		const kind = oneOf(
			issue.kind,
			['resolve-failed', 'config-failed', 'start-failed', 'dependency-blocked', 'drain-failed'],
			`${label}.issue.kind`,
		)
		if (kind !== (phase === 'dependency' ? 'dependency-blocked' : `${phase}-failed`))
			invalid(`${label}.issue contains invalid phase/kind`)
		if (typeof issue.message !== 'string') invalid(`${label}.issue.message must be a string`)
		if (issue.blockedBy !== null && (typeof issue.blockedBy !== 'string' || !issue.blockedBy))
			invalid(`${label}.issue.blockedBy must be a non-empty reference or null`)
		return Object.freeze({
			phase,
			kind,
			message: issue.message,
			blockedBy: issue.blockedBy as string | null,
		})
	})
	if (issues.length > 0 && batch.outcome === 'applied')
		invalid(`${label}.batch must report lifecycle issues`)
	return Object.freeze({ batch, lifecycle: Object.freeze({ issues: Object.freeze(issues) }) })
}

function artifactKind(input: unknown, label: string): PluginArtifactSnapshot['kind'] {
	const value = exactRecord(input, ['kind'], label)
	return oneOf(
		value.kind,
		['application-bundle', 'source-module', 'built-module', 'unreported'],
		`${label}.kind`,
	)
}

function assertUpdateWithoutScope(
	update: Readonly<Record<string, unknown>>,
	expected: 'deployment' | 'host-reload' | 'unreported',
	label: string,
): void {
	if (update.kind !== expected) invalid(`${label}.update.kind must be ${expected}`)
	assertNoScope(update, label)
}

function assertNoScope(update: Readonly<Record<string, unknown>>, label: string): void {
	if (Object.hasOwn(update, 'scope')) invalid(`${label}.update contains unsupported field scope`)
}

function assertCombination(condition: boolean, label: string): asserts condition {
	if (!condition)
		invalid(`${label} contains an invalid execution, artifact, and update combination`)
}

function frozenExecution<
	K extends 'static-bundle' | 'static-catalog' | 'dynamic-fixed',
	A extends PluginArtifactSnapshot['kind'],
	U extends 'deployment' | 'catalog-hmr' | 'manual' | 'host-reload',
>(kind: K, artifact: A, update: U): PluginExecutionSnapshot {
	return Object.freeze({
		kind,
		artifact: Object.freeze({ kind: artifact }),
		update: Object.freeze({ kind: update }),
	}) as PluginExecutionSnapshot
}

function exactRecord(
	input: unknown,
	required: readonly string[],
	label: string,
	optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		invalid(`${label} must be an object`)
	}
	const prototype = Object.getPrototypeOf(input)
	if (prototype !== Object.prototype && prototype !== null) {
		invalid(`${label} must be a plain object`)
	}
	if (Object.getOwnPropertySymbols(input).length > 0) invalid(`${label} must not contain symbols`)
	const descriptors = Object.getOwnPropertyDescriptors(input)
	const allowed = new Set([...required, ...optional])
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!allowed.has(key)) invalid(`${label} contains unsupported field ${key}`)
		if (!('value' in descriptor)) invalid(`${label}.${key} must be a data property`)
	}
	for (const key of required) {
		if (!Object.hasOwn(descriptors, key)) invalid(`${label}.${key} is required`)
	}
	return Object.fromEntries(
		Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
	)
}

function oneOf<const T extends string>(input: unknown, values: readonly T[], label: string): T {
	if (typeof input !== 'string' || !values.includes(input as T)) {
		invalid(`${label} must be one of ${values.join(', ')}`)
	}
	return input as T
}

function invalid(message: string): never {
	throw new TypeError(message)
}
