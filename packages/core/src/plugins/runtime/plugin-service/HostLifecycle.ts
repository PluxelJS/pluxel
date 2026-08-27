import type { PluginContext } from '../../../context/Context'
import type { PluginNodeSlot } from '../identity'

/** @internal Opaque identity shared by one Core lifecycle commit's host callbacks. */
export type CorePluginLifecycleOperation = Readonly<{
	revision: number
	reason: string
}>

/** @internal Stable generation input available after author init and before running admission. */
export type CoreGenerationFinalization = Readonly<{
	operation: CorePluginLifecycleOperation
	ctx: PluginContext
	signal: AbortSignal
}>

/** @internal Expected host rejection for one finalized generation candidate. */
export type CoreGenerationRejection = Readonly<{
	ctx: PluginContext
	error: unknown
}>

/** @internal Canonically ordered candidates awaiting commit-level host validation. */
export type CoreGenerationSettlement = Readonly<{
	operation: CorePluginLifecycleOperation
	/** Newly finalized candidates in stable start order for this settlement wave. */
	started: readonly PluginContext[]
	/** Cumulative generations drained so far in this operation. */
	stopped: readonly PluginContext[]
}>

/** @internal Stable changed-generation facts available immediately before summary publication. */
export type CoreCommitPublication = Readonly<{
	operation: CorePluginLifecycleOperation
	/** Final running generations created by this operation. */
	started: readonly PluginContext[]
	/** Every generation drained by this operation, including rejected transient candidates. */
	stopped: readonly PluginContext[]
	/** Planned nodes that did not enter the final running projection, including blocked nodes. */
	failed: readonly PluginNodeSlot[]
}>

/**
 * @internal Pre-root host lifecycle authority. This is deliberately absent from Plugin Context and
 * the package's default author entry point.
 */
export type CorePluginLifecycleHooks = Readonly<{
	/** Independent generations may call this concurrently; shared validation belongs in settle. */
	finalizeGeneration?: (generation: CoreGenerationFinalization) => void | Promise<void>
	/**
	 * Validates finalized candidates in provider-first, canonically stable order. It may be called
	 * more than once when a rejection restarts optional dependents in the same operation.
	 */
	settleGenerations?: (
		settlement: CoreGenerationSettlement,
	) =>
		| void
		| readonly CoreGenerationRejection[]
		| Promise<void | readonly CoreGenerationRejection[]>
	/** Builds the final immutable host state after settlement and before the no-fail exchange. */
	prepareCommit?: (publication: CoreCommitPublication) => void | Promise<void>
	/** Must synchronously exchange already-prepared host state and return exactly `undefined`. */
	publishCommit?: (publication: CoreCommitPublication) => undefined
}>

export const EMPTY_CORE_PLUGIN_LIFECYCLE_HOOKS: CorePluginLifecycleHooks = Object.freeze({})

export function freezeCorePluginLifecycleHooks(
	hooks: CorePluginLifecycleHooks = EMPTY_CORE_PLUGIN_LIFECYCLE_HOOKS,
): CorePluginLifecycleHooks {
	const finalizeGeneration = hooks.finalizeGeneration
	const settleGenerations = hooks.settleGenerations
	const prepareCommit = hooks.prepareCommit
	const publishCommit = hooks.publishCommit
	if (finalizeGeneration !== undefined && typeof finalizeGeneration !== 'function') {
		throw new TypeError('[pluxel/core] finalizeGeneration must be a function')
	}
	if (publishCommit !== undefined && typeof publishCommit !== 'function') {
		throw new TypeError('[pluxel/core] publishCommit must be a function')
	}
	if (settleGenerations !== undefined && typeof settleGenerations !== 'function') {
		throw new TypeError('[pluxel/core] settleGenerations must be a function')
	}
	if (prepareCommit !== undefined && typeof prepareCommit !== 'function') {
		throw new TypeError('[pluxel/core] prepareCommit must be a function')
	}
	return Object.freeze({
		...(finalizeGeneration ? { finalizeGeneration } : {}),
		...(settleGenerations ? { settleGenerations } : {}),
		...(prepareCommit ? { prepareCommit } : {}),
		...(publishCommit ? { publishCommit } : {}),
	})
}
