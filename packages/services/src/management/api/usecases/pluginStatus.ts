import {
	parsePluginNodeAddress,
	pluginNodeIndexKey,
	type CommitSummary,
	type Context,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	type HostOperationOptions,
	PluginGraphRejectedError,
	PluginRestartUnavailableError,
	PluginStartUnavailableError,
	HostStateMutationRejectedError,
	HostStatePersistenceError,
	HostPolicyRevisionConflictError,
	HostPolicyMutationRejectedError,
	type HostPluginGraphExclusiveSession,
	requirePluginHostCoordinator,
	requireHostStateStore,
	hostStatePatch,
	projectPluginApplyReport,
	pluginLifecycleUpdate,
	hostPluginControlFromView,
} from '@pluxel/host/internal'
import { pluginApplyReportOutcome } from '@pluxel/host/internal/protocol'
import type {
	PluginAutoStartBatchItem,
	PluginControlBatchResult,
	PluginControlMutationResult,
	PluginControlSnapshot,
	PluginApplyReport,
	PluginLifecycleCommand,
	PluginLifecycleCommandBatchItem,
} from '../../web/protocol'
import { summarizePluginControlBatch } from '../../web/control-batch'

const MAX_CONTROL_BATCH_ITEMS = 1_000
const INHERITED_STOPPED_CONTROL: PluginControlSnapshot = Object.freeze({
	autoStart: false,
	sessionIntent: 'inherit',
	desiredState: 'stopped',
	activationReason: null,
	lifecycleState: 'stopped',
})

function controlOf(
	control: PluginControlSnapshot | null,
	disappeared?: PluginControlSnapshot,
): PluginControlSnapshot {
	if (!control) {
		if (disappeared) return disappeared
		throw new Error('[runtime:control] applied Plugin node disappeared from projection')
	}
	return control
}

function readPluginControl(
	session: HostPluginGraphExclusiveSession<CommitSummary>,
	address: PluginNodeAddress,
): PluginControlSnapshot | null {
	return session.readCommitted((view) =>
		hostPluginControlFromView(
			{
				catalog: view.catalog,
				declaredNodes: view.declaredNodes,
				state: view.runtimeState.state,
				sessionIntents: view.sessionIntents,
				desiredControl: view.desiredControl,
				coreNodes: view.coreAdjacency.nodes,
				runningNodeKeys: new Set(view.runningNodes.map(pluginNodeIndexKey)),
			},
			address,
		),
	)
}

async function setOneAutoStart(
	ctx: Context,
	address: PluginNodeAddress,
	autoStart: boolean,
	session: HostPluginGraphExclusiveSession<CommitSummary>,
): Promise<PluginControlMutationResult> {
	try {
		// Enabling is admitted against the pinned catalog inside the coordinator so a stale or
		// otherwise absent address receives the precise node_unavailable contract. Disabling an
		// unknown address remains a query-level not-found instead of becoming a successful no-op.
		if (!readPluginControl(session, address) && !autoStart) return notFound(address)
		const report = await session.update({
			statePatch: hostStatePatch({ type: 'set-auto-start', node: address, autoStart }),
			reason: 'plugin-auto-start-set',
			mode: 'live',
		})
		return mutationReport(
			address,
			projectPluginApplyReport(ctx, report),
			controlOf(
				readPluginControl(session, address),
				autoStart ? undefined : INHERITED_STOPPED_CONTROL,
			),
		)
	} catch (error) {
		return mutationFailure(address, error)
	}
}

async function runLifecycleCommand(
	ctx: Context,
	address: PluginNodeAddress,
	command: PluginLifecycleCommand,
	options?: HostOperationOptions,
): Promise<PluginControlMutationResult> {
	try {
		return await requirePluginHostCoordinator(ctx).runExclusive(
			`plugin-${command}`,
			async (session) => {
				if (!readPluginControl(session, address)) return notFound(address)
				const report = await session.update(
					pluginLifecycleUpdate(command, address, `plugin-${command}`),
				)
				return mutationReport(
					address,
					projectPluginApplyReport(ctx, report),
					controlOf(
						readPluginControl(session, address),
						command === 'stop' ? INHERITED_STOPPED_CONTROL : undefined,
					),
				)
			},
			options,
		)
	} catch (error) {
		return mutationFailure(address, error)
	}
}

export async function setAutoStart(
	ctx: Context,
	input: unknown,
	options?: HostOperationOptions,
): Promise<PluginControlBatchResult> {
	const parsed = parseAutoStartItems(input)
	if (parsed.ok === false) return rejectedBatch(parsed.error)
	return requirePluginHostCoordinator(ctx).runExclusive(
		'plugin-auto-start-batch',
		async (session) => {
			try {
				session.validateRuntimeStatePatch(hostStatePatch(), options?.expectedManagedRevision)
			} catch (error) {
				return runBatch(parsed.items, ({ address }) =>
					Promise.resolve(mutationFailure(address, error)),
				)
			}
			const result = await runBatch(parsed.items, ({ address, autoStart }) =>
				setOneAutoStart(ctx, address, autoStart, session),
			)
			// Capture the managed-policy token before releasing the batch's exclusive admission.
			// A later catalog refresh can already include another client's policy write.
			return Object.freeze({
				...result,
				managedRevision: requireHostStateStore(ctx).managedRevision(),
			})
		},
		options,
	)
}

export async function applyLifecycleCommands(
	ctx: Context,
	input: unknown,
	options?: HostOperationOptions,
): Promise<PluginControlBatchResult> {
	const parsed = parseLifecycleItems(input)
	if (parsed.ok === false) return rejectedBatch(parsed.error)
	return runBatch(parsed.items, ({ address, command }) =>
		runLifecycleCommand(ctx, address, command, options),
	)
}

async function runBatch<T>(
	items: readonly T[],
	run: (item: T) => Promise<PluginControlMutationResult>,
): Promise<PluginControlBatchResult> {
	const results: PluginControlMutationResult[] = []
	for (const item of items) results.push(await run(item))
	return summarizePluginControlBatch(results)
}

function mutationReport(
	address: PluginNodeAddress,
	report: PluginApplyReport,
	control: PluginControlSnapshot,
): PluginControlMutationResult {
	const outcome = pluginApplyReportOutcome(report)
	if (outcome.status === 'applied') return { address, ok: true, status: 'applied', report, control }
	if (outcome.status === 'lifecycle_failed') {
		return {
			address,
			ok: false,
			code: 'lifecycle_failed',
			status: 'applied-with-issues',
			error: outcome.message,
			report,
			control,
		}
	}
	return {
		address,
		ok: false,
		code: 'persistence_failed',
		state: 'unknown',
		error: outcome.message,
		report,
		control,
	}
}

function parseAutoStartItems(
	input: unknown,
):
	| Readonly<{ ok: true; items: PluginAutoStartBatchItem[] }>
	| Readonly<{ ok: false; error: string }> {
	const array = parseBatch(input, 'Plugin auto-start items')
	if (array.ok === false) return array
	const items: PluginAutoStartBatchItem[] = []
	for (const [index, value] of array.items.entries()) {
		const record = closedRecord(value, ['address', 'autoStart'])
		if (!record || typeof record.autoStart !== 'boolean') {
			return { ok: false, error: `Plugin auto-start item at index ${index} is invalid` }
		}
		const address = parseAddress(record.address)
		if (!address) return { ok: false, error: `Plugin address at index ${index} is invalid` }
		items.push({ address, autoStart: record.autoStart })
	}
	return { ok: true, items }
}

function parseLifecycleItems(
	input: unknown,
):
	| Readonly<{ ok: true; items: PluginLifecycleCommandBatchItem[] }>
	| Readonly<{ ok: false; error: string }> {
	const array = parseBatch(input, 'Plugin lifecycle commands')
	if (array.ok === false) return array
	const items: PluginLifecycleCommandBatchItem[] = []
	for (const [index, value] of array.items.entries()) {
		const record = closedRecord(value, ['address', 'command'])
		if (
			!record ||
			(record.command !== 'start' && record.command !== 'stop' && record.command !== 'restart')
		) {
			return { ok: false, error: `Plugin lifecycle command at index ${index} is invalid` }
		}
		const address = parseAddress(record.address)
		if (!address) return { ok: false, error: `Plugin address at index ${index} is invalid` }
		items.push({ address, command: record.command })
	}
	return { ok: true, items }
}

function parseBatch(
	input: unknown,
	label: string,
): Readonly<{ ok: true; items: readonly unknown[] }> | Readonly<{ ok: false; error: string }> {
	if (!Array.isArray(input)) return { ok: false, error: `${label} must be an array` }
	if (input.length > MAX_CONTROL_BATCH_ITEMS) {
		return { ok: false, error: `${label} must contain at most ${MAX_CONTROL_BATCH_ITEMS} items` }
	}
	return { ok: true, items: input }
}

function closedRecord(
	value: unknown,
	keys: readonly string[],
): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const record = value as Record<string, unknown>
	const actual = Object.keys(record)
	if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return undefined
	return record
}

function parseAddress(value: unknown): PluginNodeAddress | undefined {
	try {
		return parsePluginNodeAddress(value)
	} catch {
		return undefined
	}
}

function rejectedBatch(error: string): PluginControlBatchResult {
	return {
		ok: false,
		status: 'rejected',
		code: 'invalid_input',
		state: 'unchanged',
		error,
		results: [],
	}
}

function notFound(address: PluginNodeAddress): PluginControlMutationResult {
	return {
		address,
		ok: false,
		code: 'plugin_not_found',
		state: 'unchanged',
		error: 'Plugin node is unknown',
	}
}

function mutationFailure(address: PluginNodeAddress, error: unknown): PluginControlMutationResult {
	const text = error instanceof Error ? error.message : String(error)
	if (
		error instanceof HostPolicyRevisionConflictError ||
		error instanceof HostPolicyMutationRejectedError
	) {
		return { address, ok: false, code: error.code, state: 'unchanged', error: text }
	}
	if (error instanceof HostStatePersistenceError) {
		return { address, ok: false, code: error.code, state: error.state, error: text }
	}
	if (error instanceof PluginGraphRejectedError) {
		return { address, ok: false, code: error.code, state: 'unchanged', error: text }
	}
	if (error instanceof PluginRestartUnavailableError) {
		return { address, ok: false, code: error.code, state: error.state, error: text }
	}
	if (error instanceof PluginStartUnavailableError) {
		return { address, ok: false, code: error.code, state: error.state, error: text }
	}
	if (error instanceof HostStateMutationRejectedError) {
		if (error.issue.code === 'node_unavailable' || error.issue.code === 'policy_shadowed') {
			return { address, ok: false, code: error.issue.code, state: 'unchanged', error: text }
		}
	}
	throw error
}
