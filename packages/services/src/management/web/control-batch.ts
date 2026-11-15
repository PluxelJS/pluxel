import type {
	PluginControlBatchResult,
	PluginControlMutationResult,
	PluginControlMutationSuccess,
} from './protocol'

/** Shared by execution and wire validation; uncertainty takes precedence over completion. */
export function summarizePluginControlBatch(
	input: readonly PluginControlMutationResult[],
): PluginControlBatchResult {
	const results = Object.freeze([...input])
	const successes = results.filter((result): result is PluginControlMutationSuccess => result.ok)
	if (successes.length === results.length)
		return Object.freeze({ ok: true, status: 'applied', results: Object.freeze(successes) })
	const unknown = results.some(
		(result) => result.ok === false && result.code === 'persistence_failed',
	)
	const applied = results.filter(
		(result) => result.ok === true || result.code === 'lifecycle_failed',
	).length
	return Object.freeze({
		ok: false,
		status: unknown
			? 'unknown'
			: applied === results.length
				? 'applied-with-issues'
				: applied > 0
					? 'partially-applied'
					: 'rejected',
		results,
	})
}
