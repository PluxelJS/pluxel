import {
	pluginDefinitionAddressEqual,
	pluginNodeAddressEqual,
	type Context,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import {
	PluginGraphRejectedError,
	RuntimeStateMutationRejectedError,
	RuntimeStatePersistenceError,
	pluginCatalogEntry,
	requireRuntimePluginGraphCoordinator,
	runtimeStatePatch,
} from '../../internal/reconciliation'
import { requireRuntimeStateStore } from '../../internal/runtime-state'
import { isPluginEnabled, listForkIds } from '../../services/RuntimeStateHelpers'
import type {
	BaseProviderInfo,
	PluginDependencyMutationResult,
	PluginDependencyOption,
	PluginDependencyRef,
	PluginDependencyState,
} from '../../web/protocol'
import { projectPluginApplyReport } from '../presenters/pluginApplyReport'

export class PluginNodeUnavailableError extends Error {
	constructor() {
		super('Plugin node is unavailable in the committed runtime graph policy')
		this.name = 'PluginNodeUnavailableError'
	}
}

function candidate(ctx: Context, address: PluginNodeAddress) {
	const coordinator = requireRuntimePluginGraphCoordinator(ctx)
	const entry = pluginCatalogEntry(coordinator.catalogSnapshot(), address.definition)
	if (!entry) throw new PluginNodeUnavailableError()
	if (
		address.variant === 'fork' &&
		(!entry.candidate.declaration.forkable ||
			!listForkIds(requireRuntimeStateStore(ctx).snapshot(), address.definition).includes(
				address.forkId,
			))
	) {
		throw new PluginNodeUnavailableError()
	}
	return entry.candidate
}

function explicitOverride(
	ctx: Context,
	consumer: PluginNodeAddress,
	requirement: PluginDefinitionAddress,
): PluginNodeAddress | undefined {
	return requireRuntimeStateStore(ctx)
		.snapshot()
		.dependencyOverrides.find(
			(entry) =>
				pluginNodeAddressEqual(entry.consumerAddress, consumer) &&
				pluginDefinitionAddressEqual(entry.requirementAddress, requirement),
		)?.providerAddress
}

function providerDefault(
	ctx: Context,
	token: PluginDefinitionAddress,
): PluginNodeAddress | undefined {
	return requireRuntimeStateStore(ctx)
		.snapshot()
		.providerDefaults.find((entry) => pluginDefinitionAddressEqual(entry.token, token))?.provider
}

function candidates(ctx: Context, token: PluginDefinitionAddress): PluginDependencyOption[] {
	const coordinator = requireRuntimePluginGraphCoordinator(ctx)
	const pluginService = requirePluginService(ctx)
	const state = requireRuntimeStateStore(ctx).snapshot()
	const output: PluginDependencyOption[] = []
	for (const entry of coordinator.catalogSnapshot().entries) {
		const declaration = entry.candidate.declaration
		if (
			!pluginDefinitionAddressEqual(declaration.address, token) &&
			(!declaration.provides || !pluginDefinitionAddressEqual(declaration.provides, token))
		) {
			continue
		}
		const addresses: PluginNodeAddress[] = [{ definition: declaration.address, variant: 'default' }]
		if (declaration.forkable) {
			for (const forkId of listForkIds(state, declaration.address)) {
				addresses.push({ definition: declaration.address, variant: 'fork', forkId })
			}
		}
		for (const address of addresses) {
			output.push({
				address,
				displayName: declaration.displayName,
				isEnabled: isPluginEnabled(state, address),
				isRunning: pluginService.isRunning(address),
			})
		}
	}
	return output
}

export function listPluginDependencies(
	ctx: Context,
	consumer: PluginNodeAddress,
): PluginDependencyRef[] {
	candidate(ctx, consumer)
	const pluginService = requirePluginService(ctx)
	return pluginService.resolvedDependencies(consumer).map((address) => ({
		address,
		displayName:
			pluginCatalogEntry(
				requireRuntimePluginGraphCoordinator(ctx).catalogSnapshot(),
				address.definition,
			)?.candidate.declaration.displayName ?? address.definition.exportName,
		isRunning: pluginService.isRunning(address),
	}))
}

export function inspectPluginDependencies(
	ctx: Context,
	consumer: PluginNodeAddress,
): PluginDependencyState[] {
	const declaration = candidate(ctx, consumer).declaration
	const pluginService = requirePluginService(ctx)
	const effective = pluginService.resolvedDependencies(consumer)
	return declaration.requires.map((token, index) => {
		const selected = explicitOverride(ctx, consumer, token) ?? null
		const defaultProvider = providerDefault(ctx, token) ?? null
		const resolved = effective[index] ?? null
		const options = candidates(ctx, token)
		return {
			index,
			token,
			kind: options.some(
				(option) => !pluginDefinitionAddressEqual(option.address.definition, token),
			)
				? 'abstract'
				: 'plugin',
			effective: resolved,
			isRunning: resolved ? pluginService.isRunning(resolved) : false,
			selected,
			providerDefault: defaultProvider,
			options,
		}
	})
}

export async function pluginDependencySetTarget(
	ctx: Context,
	consumer: PluginNodeAddress,
	index: number,
	provider: PluginNodeAddress | null,
): Promise<PluginDependencyMutationResult> {
	let declaration: ReturnType<typeof candidate>['declaration']
	try {
		declaration = candidate(ctx, consumer).declaration
	} catch (error) {
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
	if (!Number.isInteger(index) || index < 0 || index >= declaration.requires.length) {
		return {
			ok: false,
			code: 'invalid_index',
			state: 'unchanged',
			error: `Invalid dependency index: ${index}`,
		}
	}
	const requirement = declaration.requires[index]!
	try {
		const report = await requireRuntimePluginGraphCoordinator(ctx).updateRuntimeState(
			runtimeStatePatch({
				type: 'set-dependency-override',
				consumer,
				requirement,
				provider,
			}),
			'dependency-override',
		)
		return { ok: true, status: 'applied', report: projectPluginApplyReport(ctx, report) }
	} catch (error) {
		return dependencyMutationFailure(error)
	}
}

export async function pluginBaseProviderSet(
	ctx: Context,
	consumer: PluginNodeAddress,
	token: PluginDefinitionAddress,
	provider: PluginNodeAddress | null,
): Promise<PluginDependencyMutationResult> {
	try {
		candidate(ctx, consumer)
	} catch (error) {
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
	try {
		const report = await requireRuntimePluginGraphCoordinator(ctx).updateRuntimeState(
			runtimeStatePatch({ type: 'set-provider-default', token, provider }),
			'provider-default',
		)
		return { ok: true, status: 'applied', report: projectPluginApplyReport(ctx, report) }
	} catch (error) {
		return dependencyMutationFailure(error)
	}
}

function dependencyMutationFailure(error: unknown): PluginDependencyMutationResult {
	if (error instanceof RuntimeStateMutationRejectedError) {
		switch (error.code) {
			case 'consumer_unavailable':
			case 'provider_unavailable':
			case 'not_forkable':
			case 'requirement_not_found':
			case 'provider_incompatible':
			case 'fork_default_forbidden':
			case 'provider_default_requires_abstract':
				return {
					ok: false,
					code: error.code,
					state: 'unchanged',
					error: error.issue.message,
				}
			default:
				throw error
		}
	}
	if (error instanceof PluginGraphRejectedError) {
		return {
			ok: false,
			code: 'graph_rejected',
			state: 'unchanged',
			error: error.message,
		}
	}
	if (error instanceof RuntimeStatePersistenceError) {
		return {
			ok: false,
			code: 'persistence_failed',
			state: error.state,
			error: error.message,
		}
	}
	throw error
}

export function inspectPluginBaseProvider(
	ctx: Context,
	consumer: PluginNodeAddress,
): BaseProviderInfo | null {
	const declaration = candidate(ctx, consumer).declaration
	const token = declaration.requires.find((required) =>
		candidates(ctx, required).some(
			(option) => !pluginDefinitionAddressEqual(option.address.definition, required),
		),
	)
	if (!token) return null
	const currentDefault = providerDefault(ctx, token) ?? null
	return {
		token,
		currentDefault,
		isDefault: !!currentDefault && pluginNodeAddressEqual(currentDefault, consumer),
		providers: candidates(ctx, token),
	}
}
