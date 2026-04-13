import {
	BasePlugin,
	type Context,
	checkPluginDecorator,
	clearParamToken,
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
	setParamToken,
} from '@pluxel/core'
import {
	type BaseProvidersExtra,
	type DepOverridesExtra,
	EXTRA_BASE_PROVIDERS,
	EXTRA_DEP_OVERRIDES,
	EXTRA_FORKS,
	type ForksExtra,
} from '../../services/runtime/loader/selection'
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
	const ctor =
		ctx.loader.api.runtime.resolve(name) ?? ctx.loader.api.runtime.resolve(hint ?? name) ?? hint
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
	if (!reflectApi || typeof reflectApi !== 'object') return []
	const getMetadata = (reflectApi as { getMetadata?: unknown }).getMetadata
	if (typeof getMetadata !== 'function') return []
	try {
		const out = (getMetadata as (key: unknown, target: unknown) => unknown)(PARAM_TYPES, ctor)
		return Array.isArray(out) ? out : []
	} catch {
		return []
	}
}

function getExtraApi(ctx: Context): {
	getExtra?: (key: string) => unknown
	setExtra?: (key: string, value: unknown) => void
} {
	const svc = ctx.configService as unknown
	if (!svc || typeof svc !== 'object') return {}
	const getExtra = (svc as { getExtra?: unknown }).getExtra
	const setExtra = (svc as { setExtra?: unknown }).setExtra
	return {
		getExtra: typeof getExtra === 'function' ? getExtra.bind(svc) : undefined,
		setExtra: typeof setExtra === 'function' ? setExtra.bind(svc) : undefined,
	}
}

function readDepOverrides(ctx: Context, consumerName: string): Record<number, string> | undefined {
	const { getExtra } = getExtraApi(ctx)
	if (typeof getExtra !== 'function') return undefined
	const all = getExtra(EXTRA_DEP_OVERRIDES) as DepOverridesExtra | undefined
	return all?.[consumerName]
}

function writeDepOverride(
	ctx: Context,
	consumerName: string,
	index: number,
	targetName: string | null,
) {
	const { getExtra, setExtra } = getExtraApi(ctx)
	if (typeof getExtra !== 'function' || typeof setExtra !== 'function') return

	const all = (getExtra(EXTRA_DEP_OVERRIDES) as DepOverridesExtra | undefined) ?? {}
	const existing = all[consumerName] ? { ...all[consumerName] } : {}
	if (!targetName) delete existing[index]
	else existing[index] = targetName

	const nextAll: DepOverridesExtra = { ...all }
	if (Object.keys(existing).length === 0) delete nextAll[consumerName]
	else nextAll[consumerName] = existing
	setExtra(EXTRA_DEP_OVERRIDES, nextAll)
}

export function listPluginDependencies(ctx: Context, name: string): PluginDependencyRef[] {
	const ctor = resolvePlugin(ctx, name)
	return ctx.loader.api.deps.list(ctor)
}

export function inspectPluginDependencies(ctx: Context, name: string): PluginDependencyState[] {
	const ctor = resolvePlugin(ctx, name)
	const rawParams = readParamTypes(ctor)
	const effectiveParams = getClassParams<unknown>(ctor)
	const overrides = readDepOverrides(ctx, name)

	const out: PluginDependencyState[] = []
	for (let index = 0; index < rawParams.length; index += 1) {
		const token = rawParams[index]
		if (typeof token !== 'function') continue
		const effectiveToken = effectiveParams[index] ?? token

		const effective = tokenName(effectiveToken)
		const selected = overrides?.[index] ?? null

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
				if (typeof resolved === 'function') baseProvider = tokenName(resolved)
			} catch {}

			for (const [pluginName, pluginCtor] of ctx.loader.api.registry.listRegistered()) {
				try {
					const info = getPluginInfo(pluginCtor)
					if (info.base !== baseToken) continue
					options.push({
						name: pluginName,
						isEnabled: ctx.configService.isEnabledInConfig(pluginName),
						isRunning: ctx.loader.api.runtime.isRunning(pluginCtor),
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
			const fromCatalog =
				ctx.configService.getExtra<ForksExtra>(EXTRA_FORKS)?.[originalName] ?? []
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
				isEnabled: ctx.configService.isEnabledInConfig(originalName),
				isRunning:
					typeof original === 'function'
						? ctx.loader.api.runtime.isRunning(original as PluginConstructor)
						: false,
			})
			for (const forkId of forkIds) {
				let forkName: string
				try {
					forkName = formatForkPluginId(originalName, forkId)
				} catch {
					continue
				}
				const forkCtor = ctx.loader.api.runtime.resolve(forkName)
				options.push({
					name: forkName,
					isEnabled: ctx.configService.isEnabledInConfig(forkName),
					isRunning: forkCtor ? ctx.loader.api.runtime.isRunning(forkCtor) : false,
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

		if (!normalized) {
			clearParamToken(ctor, index)
		} else {
			const token = resolvePlugin(ctx, normalized)
			setParamToken(ctor, index, token)

			const fork = parseForkPluginId(normalized)
			if (fork) addForkToCatalog(ctx, fork.baseId, fork.forkId)

			await ctx.loader.api.control.enable(normalized, token)
		}

		ctx.registry.restart(ctor)
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

		const { getExtra, setExtra } = getExtraApi(ctx)
		const baseKey = typeof baseToken === 'string' ? baseToken.trim() : ''
		if (!baseKey) return { ok: false, code: 'invalid_base', error: 'baseToken is required' }

		const providers: Array<{
			name: string
			ctor: PluginConstructor
			baseCtor: PluginIdentifier
		}> = []
		for (const [name, pluginCtor] of ctx.loader.api.registry.listRegistered()) {
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
			if (typeof getExtra === 'function' && typeof setExtra === 'function') {
				const prev = (getExtra(EXTRA_BASE_PROVIDERS) as BaseProvidersExtra | undefined) ?? {}
				if (prev[baseKey]) {
					const next = { ...prev }
					delete next[baseKey]
					setExtra(EXTRA_BASE_PROVIDERS, next)
				}
			}
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

		if (typeof getExtra === 'function' && typeof setExtra === 'function') {
			const prev = (getExtra(EXTRA_BASE_PROVIDERS) as BaseProvidersExtra | undefined) ?? {}
			setExtra(EXTRA_BASE_PROVIDERS, { ...prev, [baseKey]: target.name })
		}

		const enabled = [...ctx.loader.api.registry.listRegistered()].filter(([name]) =>
			ctx.configService.isEnabledInConfig(name),
		)
		for (const [name, ctor] of enabled) ctx.loader.api.control.stop(name, ctor)
		for (const [name, ctor] of enabled) await ctx.loader.api.control.enable(name, ctor)
		if (!enabled.some(([name]) => name === target.name)) {
			await ctx.loader.api.control.enable(target.name, target.ctor)
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
	const { getExtra } = getExtraApi(ctx)
	const map =
		typeof getExtra === 'function'
			? ((getExtra(EXTRA_BASE_PROVIDERS) as BaseProvidersExtra | undefined) ?? {})
			: {}
	const currentDefault = (map?.[baseToken] as string | undefined) ?? null

	const providers: PluginDependencyOption[] = []
	for (const [pluginName, pluginCtor] of ctx.loader.api.registry.listRegistered()) {
		try {
			const pluginInfo = getPluginInfo(pluginCtor)
			if (pluginInfo.base !== base) continue
			providers.push({
				name: pluginName,
				isEnabled: ctx.configService.isEnabledInConfig(pluginName),
				isRunning: ctx.loader.api.runtime.isRunning(pluginCtor),
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
