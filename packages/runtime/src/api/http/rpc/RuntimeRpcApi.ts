// rpc/RuntimeRpcApi.ts - 主 RPC API
import {
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	type Context,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { writeGroups } from '../../features/pluginGroups/service'
import {
	pluginConfigGet,
	pluginConfigPatch,
	pluginConfigPatchField,
	pluginSchema,
} from '../../usecases/pluginConfig'
import {
	inspectPluginBaseProvider,
	inspectPluginDependencies,
	listPluginDependencies,
	pluginBaseProviderSet,
	pluginDependencySetTarget,
	PluginNodeUnavailableError,
} from '../../usecases/pluginDependencies'
import { ensureFork, removeFork } from '../../usecases/pluginForks'
import { applyStatusActions } from '../../usecases/pluginStatus'
import { projectPluginApplyReport } from '../../presenters/pluginApplyReport'
import { LoggingHandle } from './LoggingHandle'
import { AgentToolsHandle } from './AgentToolsHandle'
import { requireWorkbench } from '../../../services/workbench'
import type {
	BaseProviderInspectionResult,
	ConfigResult,
	EnsureForkResult,
	RemoveForkResult,
	PluginDependencyInspectionResult,
	PluginDependencyListResult,
	PluginDependencyMutationResult,
	WorkbenchRpcView,
	PluginGroup,
	PluginGroupInput,
} from '../../../web/protocol'

export class RuntimeRpcApi extends RpcTarget {
	private readonly ctx: Context

	constructor(ctx: Context) {
		super()
		this.ctx = ctx
	}

	ping() {
		return 'runtime-rpc:ok'
	}

	/** Logging settings (host-level, persisted). */
	logging() {
		return new LoggingHandle(this.ctx)
	}

	/** Persisted Agent toolsets and assignments over the live command catalog. */
	agentTools() {
		return new AgentToolsHandle(this.ctx)
	}

	workbenchRpc(grantId: string): WorkbenchRpcView {
		const workbench = requireWorkbench(this.ctx)
		const ref = workbench.registry.resolveModel(grantId, 'rpc')
		return workbench.rpc.resolve(this.ctx, ref.resourceId) as unknown as WorkbenchRpcView
	}

	async updatePluginGroups(groups: PluginGroupInput[]): Promise<PluginGroup[]> {
		const safe = Array.isArray(groups) ? groups : []
		const output = await writeGroups(this.ctx, safe)
		return output.map((group) =>
			Object.assign({}, group, {
				nodes: group.nodes.map((node) => ({
					...node,
					address: parsePluginNodeAddress(node.address),
				})),
			}),
		)
	}

	async pluginSchema(owner: unknown) {
		const address = parseRpcNode(owner)
		if (!address) {
			return {
				ok: false as const,
				code: 'invalid_input' as const,
				message: 'Invalid Plugin node address',
			}
		}
		return await pluginSchema(this.ctx, address)
	}

	async pluginConfig(owner: unknown): Promise<ConfigResult> {
		const address = parseRpcNode(owner)
		if (!address) return invalidConfigInput('Invalid Plugin node address')
		return await pluginConfigGet(this.ctx, address)
	}

	async patchPluginConfig(owner: unknown, patch: unknown): Promise<ConfigResult> {
		const address = parseRpcNode(owner)
		if (!address) return invalidConfigInput('Invalid Plugin node address')
		const record = readRpcRecord(patch)
		if (!record) return invalidConfigInput('Config patch must be an object')
		return await pluginConfigPatch(this.ctx, address, record)
	}

	async patchPluginConfigField(owner: unknown, input: unknown): Promise<ConfigResult> {
		const address = parseRpcNode(owner)
		if (!address) return invalidConfigInput('Invalid Plugin node address')
		if (!readRpcRecord(input)) return invalidConfigInput('Config field mutation must be an object')
		return await pluginConfigPatchField(this.ctx, address, input)
	}

	async pluginDependencies(owner: unknown): Promise<PluginDependencyListResult> {
		const address = parseRpcNode(owner)
		if (!address) return invalidDependencyInput('Invalid Plugin node address')
		try {
			return { ok: true, items: listPluginDependencies(this.ctx, address) }
		} catch (error) {
			return unavailableDependencyQuery(error)
		}
	}

	async inspectPluginDependencies(owner: unknown): Promise<PluginDependencyInspectionResult> {
		const address = parseRpcNode(owner)
		if (!address) return invalidDependencyInput('Invalid Plugin node address')
		try {
			return { ok: true, items: inspectPluginDependencies(this.ctx, address) }
		} catch (error) {
			return unavailableDependencyQuery(error)
		}
	}

	async setPluginDependencyTarget(input: unknown): Promise<PluginDependencyMutationResult> {
		const record = readRpcRecord(input)
		const consumer = parseRpcNode(record?.consumer)
		const provider = parseRpcNullableNode(record?.provider)
		if (!record || !consumer || !provider.ok || !Number.isInteger(record.index)) {
			return invalidDependencyInput('Invalid dependency target input')
		}
		return await pluginDependencySetTarget(
			this.ctx,
			consumer,
			record.index as number,
			provider.value,
		)
	}

	async inspectPluginBaseProvider(owner: unknown): Promise<BaseProviderInspectionResult> {
		const address = parseRpcNode(owner)
		if (!address) return invalidDependencyInput('Invalid Plugin node address')
		try {
			return { ok: true, value: inspectPluginBaseProvider(this.ctx, address) }
		} catch (error) {
			return unavailableDependencyQuery(error)
		}
	}

	async selectPluginBaseProvider(input: unknown): Promise<PluginDependencyMutationResult> {
		const record = readRpcRecord(input)
		const consumer = parseRpcNode(record?.consumer)
		const token = parseRpcDefinition(record?.token)
		const provider = parseRpcNullableNode(record?.provider)
		if (!record || !consumer || !token || !provider.ok) {
			return invalidDependencyInput('Invalid base provider input')
		}
		return await pluginBaseProviderSet(this.ctx, consumer, token, provider.value)
	}

	async ensurePluginFork(input: unknown): Promise<EnsureForkResult> {
		const record = readRpcRecord(input)
		const base = parseRpcNode(record?.base)
		const selectFor = parseRpcForkSelection(record?.selectFor)
		if (
			!record ||
			!base ||
			typeof record.forkId !== 'string' ||
			(record.enable !== undefined && typeof record.enable !== 'boolean') ||
			!selectFor.ok
		) {
			return {
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
				error: 'Invalid fork input',
			}
		}
		const result = await ensureFork(this.ctx, base, record.forkId, {
			enable: record.enable as boolean | undefined,
			...(selectFor.value === undefined ? {} : { selectFor: selectFor.value }),
		})
		if (result.ok === true) {
			const report = projectPluginApplyReport(this.ctx, result.report)
			return result.status === 'saved-not-applied'
				? {
						ok: true,
						status: result.status,
						fork: parsePluginNodeAddress(result.node),
						report,
						applicationFailure: result.applicationFailure,
					}
				: {
						ok: true,
						status: result.status,
						fork: parsePluginNodeAddress(result.node),
						report,
					}
		}
		if (result.code === 'persistence_failed') {
			return {
				ok: false,
				code: result.code,
				state: result.state,
				error: result.message,
			}
		}
		return {
			ok: false,
			code: result.code,
			state: result.state,
			error: result.message,
		}
	}

	async removePluginFork(input: unknown): Promise<RemoveForkResult> {
		const record = readRpcRecord(input)
		const base = parseRpcNode(record?.base)
		if (!record || !base || typeof record.forkId !== 'string') {
			return {
				ok: false,
				code: 'invalid_input',
				state: 'unchanged',
				error: 'Invalid fork removal input',
			}
		}
		const result = await removeFork(this.ctx, base, record.forkId)
		if (result.ok === true) {
			if (result.status === 'already-absent') {
				return {
					ok: true,
					status: result.status,
					fork: parsePluginNodeAddress(result.node),
				}
			}
			return {
				ok: true,
				status: result.status,
				fork: parsePluginNodeAddress(result.node),
				report: projectPluginApplyReport(this.ctx, result.report),
			}
		}
		if (result.code === 'fork_referenced') {
			return {
				ok: false,
				code: result.code,
				state: result.state,
				references: Object.freeze(
					result.references.map((reference) =>
						Object.freeze({
							consumer: parsePluginNodeAddress(reference.consumer),
							requirement: parsePluginDefinitionAddress(reference.requirement),
						}),
					),
				),
				error: result.message,
			}
		}
		if (result.code === 'persistence_failed') {
			return {
				ok: false,
				code: result.code,
				state: result.state,
				fork: parsePluginNodeAddress(result.node),
				...(result.report ? { report: projectPluginApplyReport(this.ctx, result.report) } : {}),
				error: result.message,
			}
		}
		return {
			ok: false,
			code: result.code,
			state: result.state,
			error: result.message,
		}
	}

	async applyPluginStatusActions(actions: unknown) {
		return await applyStatusActions(this.ctx, actions)
	}
}

function readRpcRecord(input: unknown): Record<string, unknown> | undefined {
	return input && typeof input === 'object' && !Array.isArray(input)
		? (input as Record<string, unknown>)
		: undefined
}

function parseRpcNode(input: unknown): PluginNodeAddress | undefined {
	try {
		return parsePluginNodeAddress(input)
	} catch {
		return undefined
	}
}

function parseRpcDefinition(input: unknown): PluginDefinitionAddress | undefined {
	try {
		return parsePluginDefinitionAddress(input)
	} catch {
		return undefined
	}
}

function parseRpcNullableNode(
	input: unknown,
): Readonly<{ ok: true; value: PluginNodeAddress | null }> | Readonly<{ ok: false }> {
	if (input === null) return { ok: true, value: null }
	const value = parseRpcNode(input)
	return value ? { ok: true, value } : { ok: false }
}

function parseRpcForkSelection(input: unknown):
	| Readonly<{
			ok: true
			value?: Readonly<{
				consumer: PluginNodeAddress
				requirement: PluginDefinitionAddress
			}>
	  }>
	| Readonly<{ ok: false }> {
	if (input === undefined) return { ok: true }
	const record = readRpcRecord(input)
	const consumer = parseRpcNode(record?.consumer)
	const requirement = parseRpcDefinition(record?.requirement)
	if (!record || !consumer || !requirement) return { ok: false }
	return {
		ok: true,
		value: Object.freeze({ consumer, requirement }),
	}
}

function invalidConfigInput(message: string): ConfigResult {
	return { ok: false, code: 'invalid_input', state: 'unchanged', message }
}

function invalidDependencyInput(message: string): {
	ok: false
	code: 'invalid_input'
	state: 'unchanged'
	error: string
} {
	return { ok: false, code: 'invalid_input', state: 'unchanged', error: message }
}

function unavailableDependencyQuery(error: unknown): {
	ok: false
	code: 'consumer_unavailable'
	state: 'unchanged'
	error: string
} {
	if (error instanceof PluginNodeUnavailableError) {
		return {
			ok: false,
			code: 'consumer_unavailable',
			state: 'unchanged',
			error: error.message,
		}
	}
	throw error
}
