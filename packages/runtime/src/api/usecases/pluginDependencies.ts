import {
	pluginDefinitionAddressEqual,
	pluginNodeAddressEqual,
	type Context,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	PluginGraphRejectedError,
	RuntimeStateMutationRejectedError,
	RuntimeStatePersistenceError,
	pluginCatalogEntry,
	requireRuntimePluginGraphCoordinator,
	runtimeStatePatch,
} from '../../internal/reconciliation'
import { requireRuntimeStateStore } from '../../internal/runtime-state'
import { listForkIds } from '../../services/RuntimeStateHelpers'
import type {
	PluginConsumerRequirementState,
	PluginDependencyMutationResult,
	PluginProviderOption,
	PluginProviderPolicyInfo,
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

function consumerOverride(
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

function configuredProviderDefault(
	ctx: Context,
	token: PluginDefinitionAddress,
): PluginNodeAddress | undefined {
	return requireRuntimeStateStore(ctx)
		.snapshot()
		.providerDefaults.find((entry) => pluginDefinitionAddressEqual(entry.token, token))?.provider
}

function providerOptions(ctx: Context, token: PluginDefinitionAddress): PluginProviderOption[] {
	const coordinator = requireRuntimePluginGraphCoordinator(ctx)
	const state = requireRuntimeStateStore(ctx).snapshot()
	const output: PluginProviderOption[] = []
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
				availability: 'available',
			})
		}
	}
	return output
}

export function inspectPluginConsumerRequirements(
	ctx: Context,
	consumer: PluginNodeAddress,
): PluginConsumerRequirementState[] {
	const declaration = candidate(ctx, consumer).declaration
	return declaration.requires.map((requirement) => {
		const override = consumerOverride(ctx, consumer, requirement) ?? null
		const options = providerOptions(ctx, requirement)
		const inheritedProvider =
			configuredProviderDefault(ctx, requirement) ??
			options.find(
				(option) =>
					option.address.variant === 'default' &&
					pluginDefinitionAddressEqual(option.address.definition, requirement),
			)?.address ??
			null
		return {
			requirement,
			kind: options.some(
				(option) => !pluginDefinitionAddressEqual(option.address.definition, requirement),
			)
				? 'abstract'
				: 'plugin',
			consumerOverride: override,
			inheritedProvider,
			options,
		}
	})
}

export async function setPluginConsumerOverride(
	ctx: Context,
	consumer: PluginNodeAddress,
	requirement: PluginDefinitionAddress,
	provider: PluginNodeAddress | null,
): Promise<PluginDependencyMutationResult> {
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

export async function setPluginProviderPolicyDefault(
	ctx: Context,
	policyOwner: PluginNodeAddress,
	provider: PluginNodeAddress | null,
): Promise<PluginDependencyMutationResult> {
	let token: PluginDefinitionAddress | undefined
	try {
		const declaration = candidate(ctx, policyOwner).declaration
		token = policyOwner.variant === 'default' ? declaration.provides : undefined
	} catch (error) {
		if (error instanceof PluginNodeUnavailableError) {
			return {
				ok: false,
				code: 'provider_policy_unavailable',
				state: 'unchanged',
				error: error.message,
			}
		}
		throw error
	}
	if (!token) {
		return {
			ok: false,
			code: 'provider_policy_unavailable',
			state: 'unchanged',
			error: 'Plugin node does not own an abstract provider policy',
		}
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

export function inspectPluginProviderPolicy(
	ctx: Context,
	policyOwner: PluginNodeAddress,
): PluginProviderPolicyInfo | null {
	const declaration = candidate(ctx, policyOwner).declaration
	const token = policyOwner.variant === 'default' ? declaration.provides : undefined
	if (!token) return null
	const defaultProvider = configuredProviderDefault(ctx, token) ?? null
	return {
		token,
		defaultProvider,
		policyOwnerIsDefault: !!defaultProvider && pluginNodeAddressEqual(defaultProvider, policyOwner),
		options: providerOptions(ctx, token).filter((option) => option.address.variant === 'default'),
	}
}
