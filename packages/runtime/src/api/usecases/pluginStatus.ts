import { parsePluginNodeAddress, type Context, type PluginNodeAddress } from '@pluxel/core'
import {
	PluginGraphRejectedError,
	PluginRestartUnavailableError,
	PluginStartUnavailableError,
	RuntimeStateMutationRejectedError,
	RuntimeStatePersistenceError,
	requireRuntimePluginGraphCoordinator,
	runtimeStatePatch,
} from '../../internal/reconciliation'
import type {
	PluginAutoStartBatchItem,
	PluginControlBatchResult,
	PluginControlMutationResult,
	PluginControlMutationSuccess,
	PluginControlSnapshot,
	PluginLifecycleCommand,
	PluginLifecycleCommandBatchItem,
} from '../../web/protocol'
import { projectPluginApplyReport } from '../presenters/pluginApplyReport'
import { pluginStatus } from './plugins'

const MAX_CONTROL_BATCH_ITEMS = 1_000
const INHERITED_STOPPED_CONTROL: PluginControlSnapshot = Object.freeze({
	autoStart: false,
	sessionIntent: 'inherit',
	desiredState: 'stopped',
	activationReason: null,
	lifecycleState: 'stopped',
})

function controlOf(
	status: Awaited<ReturnType<typeof pluginStatus>>,
	disappeared?: PluginControlSnapshot,
): PluginControlSnapshot {
	if (!status) {
		if (disappeared) return disappeared
		throw new Error('[runtime:control] applied Plugin node disappeared from projection')
	}
	return {
		autoStart: status.autoStart,
		sessionIntent: status.sessionIntent,
		desiredState: status.desiredState,
		activationReason: status.activationReason,
		lifecycleState: status.lifecycleState,
	}
}

async function ensureKnown(ctx: Context, address: PluginNodeAddress) {
	return await pluginStatus(ctx, address)
}

async function setOneAutoStart(
	ctx: Context,
	address: PluginNodeAddress,
	autoStart: boolean,
): Promise<PluginControlMutationResult> {
	try {
		// Enabling is admitted against the pinned catalog inside the coordinator so a stale or
		// otherwise absent address receives the precise node_unavailable contract. Disabling an
		// unknown address remains a query-level not-found instead of becoming a successful no-op.
		if (!(await ensureKnown(ctx, address)) && !autoStart) return notFound(address)
		const report = await requireRuntimePluginGraphCoordinator(ctx).updateRuntimeState(
			runtimeStatePatch({ type: 'set-auto-start', node: address, autoStart }),
			'plugin-auto-start-set',
		)
		return {
			address,
			ok: true,
			status: 'applied',
			report: projectPluginApplyReport(ctx, report),
			control: controlOf(
				await pluginStatus(ctx, address),
				autoStart ? undefined : INHERITED_STOPPED_CONTROL,
			),
		}
	} catch (error) {
		return mutationFailure(address, error)
	}
}

async function runLifecycleCommand(
	ctx: Context,
	address: PluginNodeAddress,
	command: PluginLifecycleCommand,
): Promise<PluginControlMutationResult> {
	try {
		if (!(await ensureKnown(ctx, address))) return notFound(address)
		const coordinator = requireRuntimePluginGraphCoordinator(ctx)
		const report =
			command === 'start'
				? await coordinator.startNode(address)
				: command === 'stop'
					? await coordinator.stopNode(address)
					: await coordinator.restartNode(address)
		return {
			address,
			ok: true,
			status: 'applied',
			report: projectPluginApplyReport(ctx, report),
			control: controlOf(
				await pluginStatus(ctx, address),
				command === 'stop' ? INHERITED_STOPPED_CONTROL : undefined,
			),
		}
	} catch (error) {
		return mutationFailure(address, error)
	}
}

export async function setAutoStart(
	ctx: Context,
	input: unknown,
): Promise<PluginControlBatchResult> {
	const parsed = parseAutoStartItems(input)
	if (parsed.ok === false) return rejectedBatch(parsed.error)
	return await runBatch(parsed.items, ({ address, autoStart }) =>
		setOneAutoStart(ctx, address, autoStart),
	)
}

export async function applyLifecycleCommands(
	ctx: Context,
	input: unknown,
): Promise<PluginControlBatchResult> {
	const parsed = parseLifecycleItems(input)
	if (parsed.ok === false) return rejectedBatch(parsed.error)
	return await runBatch(parsed.items, ({ address, command }) =>
		runLifecycleCommand(ctx, address, command),
	)
}

async function runBatch<T>(
	items: readonly T[],
	run: (item: T) => Promise<PluginControlMutationResult>,
): Promise<PluginControlBatchResult> {
	if (items.length === 0) return { ok: true, status: 'applied', results: [] }
	const results: PluginControlMutationResult[] = []
	for (const item of items) results.push(await run(item))
	const successes = results.filter((result): result is PluginControlMutationSuccess => result.ok)
	if (successes.length === results.length)
		return { ok: true, status: 'applied', results: successes }
	return {
		ok: false,
		status: successes.length > 0 ? 'partially-applied' : 'rejected',
		results,
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
	if (error instanceof RuntimeStatePersistenceError) {
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
	if (error instanceof RuntimeStateMutationRejectedError) {
		if (error.issue.code === 'node_unavailable') {
			return { address, ok: false, code: error.issue.code, state: 'unchanged', error: text }
		}
	}
	throw error
}
