import {
	BasePlugin,
	type Context,
	checkPluginDecorator,
	formatForkPluginId,
	ForkablePlugin,
	getClassParams,
	getDeclaredName,
	getForkId,
	getForkOf,
	getPluginInfo,
	parseForkPluginId,
	PARAM_TYPES,
	type PluginConstructor,
	type PluginIdentifier,
} from '@pluxel/core'
import { requireRouteCapability } from '../../runtime/capabilities'
import { isPluginEnabled } from '../../services/RuntimeStateStore'
import { addForkToCatalog } from './forksCatalog'
import type {
	BaseProviderInfo,
	PluginDependencyRef,
	PluginDependencyKind,
	PluginDependencyMutationResult,
	PluginDependencyOption,
	PluginDependencyState,
} from '../../web/protocol'

function resolvePlugin(ctx: Context, name: string, hint?: PluginConstructor): PluginConstructor {
	const catalog = requireRouteCapability(ctx, 'catalog')
	const ctor = catalog.resolve(name) ?? catalog.resolve(hint ?? name) ?? hint
	if (!ctor) throw new Error(`Plugin not found: ${name}`)
	return ctor
}

function tokenName(token: unknown): string {
	if (typeof token !== 'function') return String(token)
	try {
		return getPluginInfo(token as never).id
	} catch {
		const name = (token as { name?: unknown }).name
		return typeof name === 'string' ? name : String(token)
	}
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message
	if (error && typeof error === 'object') {
		const message = (error as { message?: unknown }).message
		if (typeof message === 'string') return message
	}
	return String(error)
}

function readParamTypes(ctor: PluginConstructor): unknown[] {
	const reflectApi = Reflect as unknown
	const fallback = () => [...getClassParams<unknown>(ctor)]
	if (!reflectApi || typeof reflectApi !== 'object') return fallback()
	const getMetadata = (reflectApi as { getMetadata?: unknown }).getMetadata
	if (typeof getMetadata !== 'function') return fallback()
	try {
		const out = (getMetadata as (key: unknown, target: unknown) => unknown)(PARAM_TYPES, ctor)
		return Array.isArray(out) && out.length > 0 ? out : fallback()
	} catch {
		return fallback()
	}
}

function readDepOverrides(ctx: Context, consumerName: string): Record<number, string> | undefined {
	return ctx.runtimeState.snapshot().dependencyOverrides[consumerName] as
		| Record<number, string>
		| undefined
}

function writeDepOverride(
	ctx: Context,
	consumerName: string,
	index: number,
	targetName: string | null,
) {
	ctx.runtimeState.update((draft) => {
		const existing = draft.dependencyOverrides[consumerName]
			? { ...draft.dependencyOverrides[consumerName] }
			: {}
		if (!targetName) delete existing[index]
		else existing[index] = targetName

		if (Object.keys(existing).length === 0) delete draft.dependencyOverrides[consumerName]
		else draft.dependencyOverrides[consumerName] = existing
	})
}

function buildRuntimeDependencyOverrides(
	ctx: Context,
	consumerName: string,
): Array<PluginIdentifier | undefined> | undefined {
	const persisted = readDepOverrides(ctx, consumerName)
	if (!persisted) return undefined

	const overrides: Array<PluginIdentifier | undefined> = []
	for (const [rawIndex, targetName] of Object.entries(persisted)) {
		const index = Number(rawIndex)
		if (!Number.isFinite(index) || index < 0) continue
		if (typeof targetName !== 'string' || targetName.trim() === '') continue
		overrides[index] = resolvePlugin(ctx, targetName.trim())
	}

	return overrides.length === 0 ? undefined : overrides
}

export function listPluginDependencies(ctx: Context, name: string): PluginDependencyRef[] {
	const ctor = resolvePlugin(ctx, name)
	return requireRouteCapability(ctx, 'dependencies').listDependencies(ctor)
}

export function inspectPluginDependencies(ctx: Context, name: string): PluginDependencyState[] {
	const catalog = requireRouteCapability(ctx, 'catalog')
	const lifecycle = requireRouteCapability(ctx, 'lifecycle')
	const runtimeState = ctx.runtimeState.snapshot()
	const ctor = resolvePlugin(ctx, name)
	const rawParams = readParamTypes(ctor)
	const effectiveParams = getClassParams<unknown>(ctor)
	const overrides = readDepOverrides(ctx, name)

	const out: PluginDependencyState[] = []
	for (let index = 0; index < rawParams.length; index += 1) {
		const token = rawParams[index]
		if (typeof token !== 'function') continue
		const selected = overrides?.[index] ?? null
		let effectiveToken = effectiveParams[index] ?? token
		if (selected) {
			try {
				effectiveToken = resolvePlugin(ctx, selected)
			} catch {
				// Persisted selections can point at unloaded/removed plugins; keep the build/default token.
			}
		}

		const effective = tokenName(effectiveToken)

		const isDecorated = checkPluginDecorator(token as PluginConstructor)
		const tokenProto = (token as { prototype?: unknown }).prototype
		const isBaseToken = !isDecorated && tokenProto instanceof BasePlugin

		const original = getForkOf(token as PluginConstructor) ?? token
		const originalProto = (original as { prototype?: unknown }).prototype
		const isForkable = originalProto instanceof ForkablePlugin

		let kind: PluginDependencyKind = 'plugin'
		if (isBaseToken) kind = 'base'
		else if (isForkable) kind = 'forkable'

		const isRunning = ctx.registry.isRunning(effectiveToken as PluginIdentifier)
		let baseProvider: string | null = null
		const options: PluginDependencyOption[] = []

		if (kind === 'base') {
			const baseToken = token
			try {
				const resolved = ctx.registry.graph.resolve(baseToken as PluginIdentifier)
				if (resolved !== undefined) baseProvider = tokenName(resolved)
			} catch {}

			for (const [pluginName, pluginCtor] of catalog.listRegistered()) {
				try {
					const info = getPluginInfo(pluginCtor)
					if (info.base !== baseToken) continue
					options.push({
						name: pluginName,
						isEnabled: isPluginEnabled(runtimeState, pluginName),
						isRunning: lifecycle.isRunning(pluginCtor),
					})
				} catch {}
			}
			options.sort((left, right) => left.name.localeCompare(right.name))
		} else if (kind === 'forkable') {
			let originalName: string
			try {
				originalName = getPluginInfo(original as PluginConstructor).id
			} catch {
				originalName = tokenName(original)
			}

			const forkIds: string[] = []
			const fromCatalog = ctx.runtimeState.snapshot().forks[originalName] ?? []
			for (const id of fromCatalog) {
				const forkId = typeof id === 'string' ? id.trim() : ''
				if (forkId) forkIds.push(forkId)
			}
			for (const forkCtor of ctx.registry.listForks(original as PluginConstructor)) {
				const forkId = getForkId(forkCtor)
				if (forkId && !forkIds.includes(forkId)) forkIds.push(forkId)
			}

			options.push({
				name: originalName,
				isEnabled: isPluginEnabled(runtimeState, originalName),
				isRunning:
					typeof original === 'function'
						? lifecycle.isRunning(original as PluginConstructor)
						: false,
			})
			for (const forkId of forkIds) {
				let forkName: string
				try {
					forkName = formatForkPluginId(originalName, forkId)
				} catch {
					continue
				}
				const forkCtor = catalog.resolve(forkName)
				options.push({
					name: forkName,
					isEnabled: isPluginEnabled(runtimeState, forkName),
					isRunning: forkCtor ? lifecycle.isRunning(forkCtor) : false,
				})
			}
			options.sort((left, right) => left.name.localeCompare(right.name))
		}

		out.push({
			index,
			token: tokenName(token),
			kind,
			effective,
			isRunning,
			selected,
			baseProvider,
			options,
		})
	}

	return out
}

export async function pluginDependencySetTarget(
	ctx: Context,
	name: string,
	index: number,
	targetName: string | null,
): Promise<PluginDependencyMutationResult> {
	try {
		const ctor = resolvePlugin(ctx, name)

		if (!Number.isFinite(index) || index < 0) {
			return { ok: false, code: 'invalid_index', error: `Invalid index: ${index}` }
		}

		const normalized =
			typeof targetName === 'string' && targetName.trim() ? targetName.trim() : null
		writeDepOverride(ctx, name, index, normalized)

		if (normalized) {
			const token = resolvePlugin(ctx, normalized)

			const fork = parseForkPluginId(normalized)
			if (fork) addForkToCatalog(ctx, fork.baseId, fork.forkId)

			await requireRouteCapability(ctx, 'lifecycle').enable(normalized, token)
		}

		const overrides = buildRuntimeDependencyOverrides(ctx, name)
		ctx.registry.replaceRuntimeDependencyOverrides(ctor, overrides)
		const commit = await ctx.registry.commit()
		if (commit.err) return { ok: false, code: 'commit_failed', error: String(commit.err) }
		return { ok: true }
	} catch (error) {
		return {
			ok: false,
			code: 'set_dependency_failed',
			error: getErrorMessage(error),
		}
	}
}

export async function pluginBaseProviderSet(
	ctx: Context,
	pluginName: string,
	baseToken: string,
	providerName: string | null,
): Promise<PluginDependencyMutationResult> {
	try {
		resolvePlugin(ctx, pluginName)

		const baseKey = typeof baseToken === 'string' ? baseToken.trim() : ''
		if (!baseKey) return { ok: false, code: 'invalid_base', error: 'baseToken is required' }

		const providers: Array<{
			name: string
			ctor: PluginConstructor
			baseCtor: PluginIdentifier
		}> = []
		const catalog = requireRouteCapability(ctx, 'catalog')
		const lifecycle = requireRouteCapability(ctx, 'lifecycle')
		for (const [name, pluginCtor] of catalog.listRegistered()) {
			try {
				const info = getPluginInfo(pluginCtor)
				const base = info.base
				if (!base || typeof base !== 'function') continue
				if (getDeclaredName(base) !== baseKey) continue
				providers.push({ name, ctor: pluginCtor, baseCtor: base })
			} catch {}
		}
		if (providers.length === 0) {
			return { ok: false, code: 'base_not_found', error: `No providers for base: ${baseKey}` }
		}

		const normalizedProvider =
			typeof providerName === 'string' && providerName.trim() ? providerName.trim() : null

		if (!normalizedProvider) {
			ctx.runtimeState.update((draft) => {
				delete draft.baseProviders[baseKey]
			})
			return { ok: true }
		}

		const target = providers.find((provider) => provider.name === normalizedProvider)
		if (!target) {
			return {
				ok: false,
				code: 'provider_not_found',
				error: `Provider not found: ${normalizedProvider}`,
			}
		}

		ctx.runtimeState.update((draft) => {
			draft.baseProviders[baseKey] = target.name
		})

		const runtimeState = ctx.runtimeState.snapshot()
		const enabled = [...catalog.listRegistered()].filter(([name]) =>
			isPluginEnabled(runtimeState, name),
		)
		for (const [name, ctor] of enabled) lifecycle.stop(name, ctor)
		for (const [name, ctor] of enabled) await lifecycle.enable(name, ctor)
		if (!enabled.some(([name]) => name === target.name)) {
			await lifecycle.enable(target.name, target.ctor)
		}

		try {
			ctx.registry.restart(target.baseCtor)
		} catch {}

		const commit = await ctx.registry.commit()
		if (commit.err) return { ok: false, code: 'commit_failed', error: String(commit.err) }
		return { ok: true }
	} catch (error) {
		return { ok: false, code: 'set_base_failed', error: getErrorMessage(error) }
	}
}

export function inspectPluginBaseProvider(ctx: Context, name: string): BaseProviderInfo | null {
	const ctor = resolvePlugin(ctx, name)
	const info = getPluginInfo(ctor)
	const base = info.base
	if (!base || typeof base !== 'function') return null

	const baseToken = getDeclaredName(base)
	const map = ctx.runtimeState.snapshot().baseProviders
	const currentDefault = (map?.[baseToken] as string | undefined) ?? null

	const providers: PluginDependencyOption[] = []
	const catalog = requireRouteCapability(ctx, 'catalog')
	const lifecycle = requireRouteCapability(ctx, 'lifecycle')
	for (const [pluginName, pluginCtor] of catalog.listRegistered()) {
		try {
			const pluginInfo = getPluginInfo(pluginCtor)
			if (pluginInfo.base !== base) continue
			providers.push({
				name: pluginName,
				isEnabled: isPluginEnabled(ctx.runtimeState.snapshot(), pluginName),
				isRunning: lifecycle.isRunning(pluginCtor),
			})
		} catch {}
	}
	providers.sort((left, right) => left.name.localeCompare(right.name))

	return {
		baseToken,
		currentDefault,
		isDefault: currentDefault === name,
		providers,
	}
}
