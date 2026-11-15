import type { CommitSummary } from '../plugins/runtime/plugin-service/CommitPlan'
import type {
	PluginLifecycleErrorInfo,
	PluginLifecycleIssueKind,
	PluginLifecycleIssuePhase,
} from '../plugins/runtime/plugin-service/LifecycleReport'
import type { PluginService } from '../plugins/runtime/PluginService'
import type { PluginConstructor } from '../plugins/types'
import { readPluginNodeAddressEvidence } from '../internal/plugin-address-evidence'
import {
	formatPluginNodeReference,
	isPluginNodeSlot,
	parsePluginNodeAddress,
	pluginDefinitionAddressEqual,
	type PluginNodeAddress,
	type PluginInstanceNodeAddress,
} from '../plugins/runtime/identity'

export type RawPluginConfig = Readonly<Record<string, unknown>>

/** Original source-class address; the exact value supplies its implementation to the test host. */
export type PluginTestTarget = PluginInstanceNodeAddress<any>

export type PluginInstanceFor<TTarget extends PluginTestTarget> =
	TTarget extends PluginInstanceNodeAddress<infer S> ? S : never

export type PluginInstances<TTargets extends readonly PluginTestTarget[]> = {
	readonly [Index in keyof TTargets]: TTargets[Index] extends PluginTestTarget
		? PluginInstanceFor<TTargets[Index]>
		: never
}

export type PluginTestLifecycleIssue = Readonly<{
	plugin: PluginNodeAddress
	phase: PluginLifecycleIssuePhase
	kind: PluginLifecycleIssueKind
	message: string
	error?: PluginLifecycleErrorInfo
	blockedBy?: PluginNodeAddress
}>

export type PluginTestCommitSummary = Readonly<{
	lifecycleReport: Readonly<{
		ok: boolean
		issues: readonly PluginTestLifecycleIssue[]
	}>
}>

export type LifecycleFailureCommitSummary = PluginTestCommitSummary &
	Readonly<{
		lifecycleReport: Readonly<{
			ok: false
			issues: readonly [PluginTestLifecycleIssue, ...PluginTestLifecycleIssue[]]
		}>
	}>

export type PluginLifecycleAssertionOperation =
	| 'add'
	| 'remove'
	| 'start'
	| 'stop'
	| 'restart'
	| 'replaceDefinition'
	| 'commit'
	| 'commitExpectFail'

/**
 * A fixture mutation committed, but its requested lifecycle postcondition was not met.
 * Programming, graph-validation, persistence, capability, and teardown failures are not wrapped.
 */
export class PluginLifecycleAssertionError extends Error {
	readonly code = 'PLUGIN_TEST_LIFECYCLE_ASSERTION_FAILED' as const
	readonly operation: PluginLifecycleAssertionOperation
	readonly targets: readonly PluginTestTarget[]
	readonly summary: PluginTestCommitSummary

	constructor(
		operation: PluginLifecycleAssertionOperation,
		targets: readonly PluginTestTarget[],
		summary: PluginTestCommitSummary,
	) {
		const labels = targets.map(formatPluginTestTarget).join(', ') || '<draft>'
		const issues = summary.lifecycleReport.issues.map((issue) => issue.kind).join(', ')
		super(
			`[pluxel/test] ${operation}(${labels}) did not satisfy the requested Plugin lifecycle postcondition${issues ? `: ${issues}` : ''}`,
		)
		this.name = 'PluginLifecycleAssertionError'
		this.operation = operation
		this.targets = Object.freeze([...targets])
		this.summary = summary
		Object.setPrototypeOf(this, PluginLifecycleAssertionError.prototype)
	}
}

export type ResolvedPluginTestTarget = Readonly<{
	implementation: PluginConstructor
	address: PluginNodeAddress
}>

/** @internal Shared target normalization for Core- and Runtime-owned test hosts. */
export function resolvePluginTestTarget(target: PluginTestTarget): ResolvedPluginTestTarget {
	const evidence = readPluginNodeAddressEvidence(target)
	if (
		!evidence ||
		typeof evidence !== 'object' ||
		!('kind' in evidence) ||
		evidence.kind !== 'constructor' ||
		!('implementation' in evidence) ||
		typeof evidence.implementation !== 'function'
	) {
		throw new TypeError(
			'[pluxel/test] Plugin target requires an original concrete Plugin class nodeAddress() value',
		)
	}
	const implementation = evidence.implementation as PluginConstructor
	const address = parsePluginNodeAddress(target)
	if (!pluginDefinitionAddressEqual(address.definition, implementation.definitionAddress())) {
		throw new TypeError(
			'[pluxel/test] Plugin address and implementation evidence must identify the same definition',
		)
	}
	return Object.freeze({
		implementation,
		address,
	})
}

export type AssertPluginTestTargetCurrentOptions = Readonly<{
	/** Permit a definition that has not entered this host yet. Existing definitions are still stale-checked. */
	allowAbsent?: boolean
}>

/** @internal Reject source addresses bound to an implementation replaced in this host. */
export function assertPluginTestTargetCurrent(
	registry: PluginService,
	target: PluginTestTarget,
	options: AssertPluginTestTargetCurrentOptions = {},
): PluginNodeAddress {
	const resolved = resolvePluginTestTarget(target)
	const implementation = findCurrentDefinitionImplementation(registry, resolved.address)
	if (!implementation) {
		if (options.allowAbsent) return resolved.address
		throw new Error(
			`[pluxel/test] Plugin target is not materialized: ${formatPluginNodeReference(resolved.address)}`,
		)
	}
	if (implementation !== resolved.implementation) {
		throw new Error(
			`[pluxel/test] Stale Plugin target ${formatPluginTestTarget(target)}; obtain nodeAddress() from the current replacement implementation`,
		)
	}
	return resolved.address
}

/** @internal Project all lifecycle identities away from process-local slots. */
export function projectPluginTestCommitSummary(
	summary: CommitSummary,
	registry: PluginService,
): PluginTestCommitSummary {
	const issues = summary.lifecycleReport.issues.map((issue): PluginTestLifecycleIssue => {
		const error = issue.error
			? Object.freeze({
					name: issue.error.name,
					message: issue.error.message,
					...(issue.error.stack === undefined ? {} : { stack: issue.error.stack }),
					...(issue.error.cause === undefined ? {} : { cause: issue.error.cause }),
					...(issue.error.partPath === undefined
						? {}
						: { partPath: Object.freeze([...issue.error.partPath]) }),
				})
			: undefined
		return Object.freeze({
			plugin: registry.nodeAddressOf(issue.plugin),
			phase: issue.phase,
			kind: issue.kind,
			message: issue.message,
			...(error === undefined ? {} : { error }),
			...(issue.blockedBy === undefined
				? {}
				: { blockedBy: registry.nodeAddressOf(issue.blockedBy) }),
		})
	})
	return Object.freeze({
		lifecycleReport: Object.freeze({
			ok: issues.length === 0,
			issues: Object.freeze(issues),
		}),
	})
}

export interface PluginTestDraftAuthority {
	assertActive(action: string): void
	recordCommand(action: string): void
}

/**
 * @internal Invoke a callback-scoped draft and enforce sync, no-return, no-escape and non-empty rules.
 * Domain-specific normalization and conflict detection stay in the supplied change implementation.
 */
export function collectPluginTestDraft<TChange, TPlan>(
	build: (change: TChange) => undefined,
	create: (authority: PluginTestDraftAuthority) => Readonly<{ change: TChange; plan: TPlan }>,
): TPlan {
	let active = true
	let commandCount = 0
	const authority: PluginTestDraftAuthority = Object.freeze({
		assertActive(action: string) {
			if (!active) {
				throw new Error(
					`[pluxel/test] Cannot call ${action} after the commit callback returned; draft authority cannot escape its callback`,
				)
			}
		},
		recordCommand(action: string) {
			this.assertActive(action)
			commandCount++
		},
	})
	const created = create(authority)
	let result: unknown
	try {
		result = build(created.change)
	} finally {
		active = false
	}
	if (result !== undefined) {
		observeRejectedThenable(result)
		throw new TypeError(
			isThenable(result)
				? '[pluxel/test] commit callback must be synchronous and return undefined'
				: '[pluxel/test] commit callback must return undefined',
		)
	}
	if (commandCount === 0) {
		throw new TypeError('[pluxel/test] commit callback must record at least one change')
	}
	return created.plan
}

/** @internal Shared fail-fast mutation/query/disposal gate for test resources. */
export class PluginTestOperationGate {
	private state: 'open' | 'closing' | 'closed' = 'open'
	private active?: Promise<unknown>
	private activeOperation?: string
	private disposal?: Promise<void>

	runMutation<T>(operation: string, run: () => Promise<T> | T): Promise<T> {
		if (this.state !== 'open') return Promise.reject(this.closedError(operation))
		if (this.active) return Promise.reject(this.concurrentError(operation))
		this.activeOperation = operation
		const task = Promise.resolve().then(run)
		this.active = task
		void task.then(
			() => this.clearActive(task),
			() => this.clearActive(task),
		)
		return task
	}

	assertReadable(action: string): void {
		if (this.state !== 'open') throw this.closedError(action)
		if (this.active) throw this.concurrentError(action)
	}

	assertAccepting(action: string): void {
		if (this.state !== 'open') throw this.closedError(action)
	}

	dispose(run: () => Promise<void> | void): Promise<void> {
		if (this.disposal) return this.disposal
		this.state = 'closing'
		const active = this.active
		const disposal = (async () => {
			if (active) await active.catch((): undefined => undefined)
			try {
				await run()
			} finally {
				this.state = 'closed'
			}
		})()
		this.disposal = disposal
		return disposal
	}

	private clearActive(task: Promise<unknown>): void {
		if (this.active !== task) return
		this.active = undefined
		this.activeOperation = undefined
	}

	private concurrentError(operation: string): Error {
		return new Error(
			`[pluxel/test] Cannot run ${operation} while ${this.activeOperation ?? 'another mutation'} is in progress; await operations in order, use a literal batch, or group changes in commit(callback)`,
		)
	}

	private closedError(action: string): Error {
		return new Error(`[pluxel/test] Cannot run ${action}; the test host is closing or closed`)
	}
}

function findCurrentDefinitionImplementation(
	registry: PluginService,
	address: PluginNodeAddress,
): PluginConstructor | undefined {
	const exact = registry.resolvePluginNode(address)
	if (exact) return registry.graph.declaration(exact)?.meta?.definition.implementation
	for (const key of registry.graph.keys()) {
		if (!isPluginNodeSlot(key)) continue
		const currentAddress = registry.nodeAddressOf(key)
		if (!pluginDefinitionAddressEqual(currentAddress.definition, address.definition)) continue
		return registry.graph.declaration(key)?.meta?.definition.implementation
	}
	return undefined
}

function formatPluginTestTarget(target: PluginTestTarget): string {
	const resolved = resolvePluginTestTarget(target)
	return resolved.address.variant === 'fork'
		? `${resolved.implementation.name || '<anonymous>'}#${resolved.address.forkId}`
		: resolved.implementation.name || resolved.address.definition.exportName
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
	if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return false
	try {
		return typeof (value as { then?: unknown }).then === 'function'
	} catch {
		return false
	}
}

function observeRejectedThenable(value: unknown): void {
	if (!isThenable(value)) return
	void Promise.resolve(value).catch((): undefined => undefined)
}
