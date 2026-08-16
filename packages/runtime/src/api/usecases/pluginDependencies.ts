import {
	getPluginDefinitionFacts,
	isPluginNodeSlot,
	pluginNodeAddressEqual,
	type Context,
	type PluginDefinitionAddressSnapshot,
	type PluginNodeAddressSnapshot,
	type PluginNodeSlot,
} from '@pluxel/core'
import { requireRouteCapability } from '../../runtime/capabilities'
import {
	isPluginEnabled,
	samePluginDefinitionAddress,
	samePluginNodeAddress,
} from '../../services/RuntimeStateHelpers'
import type {
	BaseProviderInfo,
	PluginDependencyMutationResult,
	PluginDependencyOption,
	PluginDependencyRef,
	PluginDependencyState,
} from '../../web/protocol'

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function resolve(ctx: Context, address: PluginNodeAddressSnapshot) {
	const ctor = requireRouteCapability(ctx, 'catalog').resolve(address)
	if (!ctor) throw new Error('Plugin node is not present in the route catalog')
	return ctor
}

function explicitOverride(
	ctx: Context,
	consumer: PluginNodeAddressSnapshot,
	index: number,
): PluginNodeAddressSnapshot | undefined {
	return ctx.runtimeState
		.snapshot()
		.dependencyOverrides.find(
			(entry) => samePluginNodeAddress(entry.consumer, consumer) && entry.parameterIndex === index,
		)?.provider
}

function providerDefault(
	ctx: Context,
	token: PluginDefinitionAddressSnapshot,
): PluginNodeAddressSnapshot | undefined {
	return ctx.runtimeState
		.snapshot()
		.providerDefaults.find((entry) => samePluginDefinitionAddress(entry.token, token))?.provider
}

function candidates(
	ctx: Context,
	token: PluginDefinitionAddressSnapshot,
): PluginDependencyOption[] {
	const state = ctx.runtimeState.snapshot()
	const lifecycle = requireRouteCapability(ctx, 'lifecycle')
	return requireRouteCapability(ctx, 'catalog')
		.listRegistered()
		.filter((entry) => {
			const facts = getPluginDefinitionFacts(entry.ctor)
			return (
				samePluginDefinitionAddress(facts.definition, token) ||
				(!!facts.provides && samePluginDefinitionAddress(facts.provides, token))
			)
		})
		.map((entry) => ({
			address: entry.address,
			displayName: entry.displayName,
			isEnabled: isPluginEnabled(state, entry.address),
			isRunning: lifecycle.isRunning(entry.address),
		}))
}

function effectiveNode(
	ctx: Context,
	consumer: PluginNodeSlot,
	index: number,
): PluginNodeAddressSnapshot | null {
	const resolved = ctx.registry.graph.depsOf(consumer)[index]
	return isPluginNodeSlot(resolved) ? ctx.registry.nodeAddressOf(resolved) : null
}

export function listPluginDependencies(
	ctx: Context,
	consumer: PluginNodeAddressSnapshot,
): PluginDependencyRef[] {
	const ctor = resolve(ctx, consumer)
	const facts = getPluginDefinitionFacts(ctor)
	const slot = ctx.registry.internNodeAddress(consumer)
	return facts.requires.flatMap((_token, index) => {
		const address = effectiveNode(ctx, slot, index)
		if (!address) return []
		const provider = requireRouteCapability(ctx, 'catalog').resolve(address)
		return [
			{
				address,
				displayName: provider
					? getPluginDefinitionFacts(provider).definition.exportName
					: address.definition.exportName,
				isRunning: requireRouteCapability(ctx, 'lifecycle').isRunning(address),
			},
		]
	})
}

export function inspectPluginDependencies(
	ctx: Context,
	consumer: PluginNodeAddressSnapshot,
): PluginDependencyState[] {
	const ctor = resolve(ctx, consumer)
	const facts = getPluginDefinitionFacts(ctor)
	const consumerSlot = ctx.registry.internNodeAddress(consumer)
	return facts.requires.map((token, index) => {
		const selected = explicitOverride(ctx, consumer, index) ?? null
		const defaultProvider = providerDefault(ctx, token) ?? null
		const effective = effectiveNode(ctx, consumerSlot, index)
		return {
			index,
			token,
			kind: candidates(ctx, token).some(
				(option) => !samePluginDefinitionAddress(option.address.definition, token),
			)
				? 'abstract'
				: 'plugin',
			effective,
			isRunning: effective ? requireRouteCapability(ctx, 'lifecycle').isRunning(effective) : false,
			selected,
			providerDefault: defaultProvider,
			options: candidates(ctx, token),
		}
	})
}

function replaceExplicitOverride(
	ctx: Context,
	consumer: PluginNodeAddressSnapshot,
	index: number,
	provider: PluginNodeAddressSnapshot | null,
): void {
	ctx.runtimeState.update((draft) => {
		draft.dependencyOverrides = draft.dependencyOverrides.filter(
			(entry) =>
				!(samePluginNodeAddress(entry.consumer, consumer) && entry.parameterIndex === index),
		)
		if (provider) draft.dependencyOverrides.push({ consumer, parameterIndex: index, provider })
	})
}

function applyRuntimeOverrides(ctx: Context, consumer: PluginNodeAddressSnapshot): void {
	const ctor = resolve(ctx, consumer)
	const facts = getPluginDefinitionFacts(ctor)
	const overrides = facts.requires.map((token, index) => {
		const address = explicitOverride(ctx, consumer, index) ?? providerDefault(ctx, token)
		return address ? ctx.registry.internNodeAddress(address) : undefined
	})
	ctx.registry.replaceRuntimeDependencyOverrides(
		ctx.registry.internNodeAddress(consumer),
		overrides,
	)
}

export async function pluginDependencySetTarget(
	ctx: Context,
	consumer: PluginNodeAddressSnapshot,
	index: number,
	provider: PluginNodeAddressSnapshot | null,
): Promise<PluginDependencyMutationResult> {
	try {
		const facts = getPluginDefinitionFacts(resolve(ctx, consumer))
		if (!Number.isInteger(index) || index < 0 || index >= facts.requires.length) {
			return { ok: false, code: 'invalid_index', error: `Invalid dependency index: ${index}` }
		}
		if (provider) {
			resolve(ctx, provider)
			await requireRouteCapability(ctx, 'lifecycle').enable(provider)
		}
		replaceExplicitOverride(ctx, consumer, index, provider)
		applyRuntimeOverrides(ctx, consumer)
		const commit = await ctx.registry.commit()
		return commit.err
			? { ok: false, code: 'commit_failed', error: String(commit.err) }
			: { ok: true }
	} catch (error) {
		return { ok: false, code: 'set_dependency_failed', error: message(error) }
	}
}

export async function pluginBaseProviderSet(
	ctx: Context,
	consumer: PluginNodeAddressSnapshot,
	token: PluginDefinitionAddressSnapshot,
	provider: PluginNodeAddressSnapshot | null,
): Promise<PluginDependencyMutationResult> {
	try {
		resolve(ctx, consumer)
		if (provider) {
			const allowed = candidates(ctx, token).some((entry) =>
				pluginNodeAddressEqual(entry.address, provider),
			)
			if (!allowed)
				return {
					ok: false,
					code: 'provider_not_found',
					error: 'Provider does not implement the requested token',
				}
			await requireRouteCapability(ctx, 'lifecycle').enable(provider)
		}
		ctx.runtimeState.update((draft) => {
			draft.providerDefaults = draft.providerDefaults.filter(
				(entry) => !samePluginDefinitionAddress(entry.token, token),
			)
			if (provider) draft.providerDefaults.push({ token, provider })
		})
		for (const entry of requireRouteCapability(ctx, 'catalog').listRegistered()) {
			if (
				getPluginDefinitionFacts(entry.ctor).requires.some((required) =>
					samePluginDefinitionAddress(required, token),
				)
			)
				applyRuntimeOverrides(ctx, entry.address)
		}
		const commit = await ctx.registry.commit()
		return commit.err
			? { ok: false, code: 'commit_failed', error: String(commit.err) }
			: { ok: true }
	} catch (error) {
		return { ok: false, code: 'set_provider_default_failed', error: message(error) }
	}
}

export function inspectPluginBaseProvider(
	ctx: Context,
	consumer: PluginNodeAddressSnapshot,
): BaseProviderInfo | null {
	const facts = getPluginDefinitionFacts(resolve(ctx, consumer))
	const token = facts.requires.find((required) =>
		candidates(ctx, required).some(
			(option) => !samePluginDefinitionAddress(option.address.definition, required),
		),
	)
	if (!token) return null
	const currentDefault = providerDefault(ctx, token) ?? null
	return {
		token,
		currentDefault,
		isDefault: !!currentDefault && samePluginNodeAddress(currentDefault, consumer),
		providers: candidates(ctx, token),
	}
}
