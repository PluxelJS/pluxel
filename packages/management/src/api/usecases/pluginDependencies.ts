import {
	pluginDefinitionAddressEqual,
	pluginNodeAddressEqual,
	type Context,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	PluginGraphRejectedError,
	HostStateMutationRejectedError,
	HostStatePersistenceError,
	pluginCatalogEntry,
	requirePluginHostCoordinator,
	hostStatePatch,
	listForkIds,
	type HostPluginGraphCommittedView,
	type HostOperationOptions,
} from '@pluxel/host/internal'
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

function candidate(view: HostPluginGraphCommittedView, address: PluginNodeAddress) {
	const entry = pluginCatalogEntry(view.catalog, address.definition)
	if (!entry) throw new PluginNodeUnavailableError()
	if (
		address.variant === 'fork' &&
		(!entry.candidate.declaration.forkable ||
			!listForkIds(view.runtimeState.state, address.definition).includes(address.forkId))
	) {
		throw new PluginNodeUnavailableError()
	}
	return entry.candidate
}

function consumerOverride(
	view: HostPluginGraphCommittedView,
	consumer: PluginNodeAddress,
	requirement: PluginDefinitionAddress,
): PluginNodeAddress | undefined {
	return view.runtimeState.state.dependencyOverrides.find(
		(entry) =>
			pluginNodeAddressEqual(entry.consumerAddress, consumer) &&
			pluginDefinitionAddressEqual(entry.requirementAddress, requirement),
	)?.providerAddress
}

function configuredProviderDefault(
	view: HostPluginGraphCommittedView,
	token: PluginDefinitionAddress,
): PluginNodeAddress | undefined {
	return view.runtimeState.state.providerDefaults.find((entry) =>
		pluginDefinitionAddressEqual(entry.token, token),
	)?.provider
}

function providerOptions(
	view: HostPluginGraphCommittedView,
	token: PluginDefinitionAddress,
): PluginProviderOption[] {
	const state = view.runtimeState.state
	const output: PluginProviderOption[] = []
	for (const entry of view.catalog.entries) {
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

function projectConsumerRequirements(
	view: HostPluginGraphCommittedView,
	consumer: PluginNodeAddress,
): PluginConsumerRequirementState[] {
	const declaration = candidate(view, consumer).declaration
	return declaration.requires.map((requirement) => {
		const override = consumerOverride(view, consumer, requirement) ?? null
		const options = providerOptions(view, requirement)
		const inheritedProvider =
			configuredProviderDefault(view, requirement) ??
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
	options?: HostOperationOptions,
): Promise<PluginDependencyMutationResult> {
	try {
		const report = await requirePluginHostCoordinator(ctx).updateRuntimeState(
			hostStatePatch({
				type: 'set-dependency-override',
				consumer,
				requirement,
				provider,
			}),
			'dependency-override',
			options,
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
	options?: HostOperationOptions,
): Promise<PluginDependencyMutationResult> {
	let token: PluginDefinitionAddress | undefined
	try {
		const declaration = await requirePluginHostCoordinator(ctx).readCommitted(
			(view) => candidate(view, policyOwner).declaration,
			options,
		)
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
	return setPluginProviderDefault(ctx, token, provider, options)
}

/** Shared token-based policy mutation for host control surfaces. */
export async function setPluginProviderDefault(
	ctx: Context,
	token: PluginDefinitionAddress,
	provider: PluginNodeAddress | null,
	options?: HostOperationOptions,
): Promise<PluginDependencyMutationResult> {
	try {
		const report = await requirePluginHostCoordinator(ctx).updateRuntimeState(
			hostStatePatch({ type: 'set-provider-default', token, provider }),
			'provider-default',
			options,
		)
		return { ok: true, status: 'applied', report: projectPluginApplyReport(ctx, report) }
	} catch (error) {
		return dependencyMutationFailure(error)
	}
}

function dependencyMutationFailure(error: unknown): PluginDependencyMutationResult {
	if (error instanceof HostStateMutationRejectedError) {
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
	if (error instanceof HostStatePersistenceError) {
		return {
			ok: false,
			code: 'persistence_failed',
			state: error.state,
			error: error.message,
		}
	}
	throw error
}

function projectProviderPolicy(
	view: HostPluginGraphCommittedView,
	policyOwner: PluginNodeAddress,
): PluginProviderPolicyInfo | null {
	const declaration = candidate(view, policyOwner).declaration
	const token = policyOwner.variant === 'default' ? declaration.provides : undefined
	if (!token) return null
	const defaultProvider = configuredProviderDefault(view, token) ?? null
	return {
		token,
		defaultProvider,
		policyOwnerIsDefault: !!defaultProvider && pluginNodeAddressEqual(defaultProvider, policyOwner),
		options: providerOptions(view, token).filter((option) => option.address.variant === 'default'),
	}
}

export function inspectPluginConsumerRequirements(
	ctx: Context,
	consumer: PluginNodeAddress,
	options?: HostOperationOptions,
): Promise<PluginConsumerRequirementState[]> {
	return requirePluginHostCoordinator(ctx).readCommitted(
		(view) => projectConsumerRequirements(view, consumer),
		options,
	)
}
export function inspectPluginProviderPolicy(
	ctx: Context,
	policyOwner: PluginNodeAddress,
	options?: HostOperationOptions,
): Promise<PluginProviderPolicyInfo | null> {
	return requirePluginHostCoordinator(ctx).readCommitted(
		(view) => projectProviderPolicy(view, policyOwner),
		options,
	)
}
