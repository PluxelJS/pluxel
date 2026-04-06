// rpc/PluginHandle.ts - 插件操作 RPC
import {
	BasePlugin,
	type Context,
	checkPluginDecorator,
	clearParamToken,
	formatForkPluginId,
	ForkablePlugin,
	type ForkablePluginConstructor,
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
import { RpcTarget } from 'capnweb'
import {
	type BaseProvidersExtra,
	type DepOverridesExtra,
	EXTRA_BASE_PROVIDERS,
	EXTRA_DEP_OVERRIDES,
	EXTRA_FORKS,
	type ForksExtra,
} from '../../../services/runtime/loader/selection'
import { addForkToCatalog } from '../../usecases/forksCatalog'
import {
	pluginConfigGet,
	pluginConfigPatch,
	pluginConfigPatchField,
	pluginConfigReset,
	pluginConfigValidate,
	pluginSchema,
} from '../../usecases/pluginConfig'
import { applyStatusActions } from '../../usecases/pluginStatus'
import type {
	BaseProvisionInfo,
	ConfigPatch,
	ConfigResult,
	ConfigResultOk,
	ConfigFieldMutation,
	EnsureForkResult,
	PluginDependencyKind,
	PluginDependencyMutationResult,
	PluginDependencyOption,
	PluginDependencyState,
	PluginStatusAction,
	SchemaResult,
} from '../../../web/protocol'

function resolvePlugin(ctx: Context, name: string, hint?: PluginConstructor): PluginConstructor {
	const ctor =
		ctx.loader.api.runtime.resolve(name) ?? ctx.loader.api.runtime.resolve(hint ?? name) ?? hint
	if (!ctor) throw new Error(`Plugin not found: ${name}`)
	return ctor
}

function tokenName(token: unknown): string {
	if (typeof token !== 'function') return String(token)
	try {
		return getPluginInfo(token as unknown as never).id
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
	const r = Reflect as unknown
	if (!r || typeof r !== 'object') return []
	const getMetadata = (r as { getMetadata?: unknown }).getMetadata
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
	if (!targetName) {
		delete existing[index]
	} else {
		existing[index] = targetName
	}
	const nextAll: DepOverridesExtra = { ...all }
	if (Object.keys(existing).length === 0) delete nextAll[consumerName]
	else nextAll[consumerName] = existing
	setExtra(EXTRA_DEP_OVERRIDES, nextAll)
}

export class PluginHandle extends RpcTarget {
	readonly name: string
	private readonly ctx: Context
	private readonly hint: PluginConstructor

	constructor(ctx: Context, name: string) {
		super()
		this.ctx = ctx
		this.name = name
		this.hint = resolvePlugin(ctx, name)
	}

	private resolveCtor(): PluginConstructor {
		return resolvePlugin(this.ctx, this.name, this.hint)
	}

	detail() {
		const ctor = this.resolveCtor()
		return {
			name: this.name,
			desc: '插件示例描述',
			dependencies: this.ctx.loader.api.deps.list(ctor),
		}
	}

	async updateStatus(action: PluginStatusAction) {
		const batch = await applyStatusActions(this.ctx, [{ name: this.name, action }])
		const res = batch.results[0]
		if (!res) {
			return {
				ok: false as const,
				code: 'unknown',
				error: 'Empty status result',
			}
		}
		if (batch.ok && res.ok) return res
		return {
			...res,
			ok: false as const,
			code: res.code ?? (batch.commitError ? 'commit_failed' : 'plugin_operation_failed'),
			error: res.error ?? batch.commitError ?? 'Unknown error',
		}
	}

	async dependencyState(): Promise<PluginDependencyState[]> {
		const ctor = this.resolveCtor()
		const rawParams = readParamTypes(ctor)
		const effectiveParams = getClassParams<unknown>(ctor)
		const overrides = readDepOverrides(this.ctx, this.name)

		const out: PluginDependencyState[] = []
		for (let i = 0; i < rawParams.length; i++) {
			const token = rawParams[i]
			if (typeof token !== 'function') continue
			const effectiveToken = effectiveParams[i] ?? token

			const effective = tokenName(effectiveToken)
			const selected = overrides?.[i] ?? null

			const isDecorated = checkPluginDecorator(token as unknown as PluginConstructor)
			const tokenProto = (token as { prototype?: unknown }).prototype
			const isBaseToken = !isDecorated && tokenProto instanceof BasePlugin

			const original = getForkOf(token as unknown as PluginConstructor) ?? token
			const originalProto = (original as { prototype?: unknown }).prototype
			const isForkable = originalProto instanceof ForkablePlugin

			let kind: PluginDependencyKind = 'plugin'
			if (isBaseToken) kind = 'base'
			else if (isForkable) kind = 'forkable'

			const isRunning = this.ctx.registry.isRunning(effectiveToken as unknown as PluginIdentifier)
			let baseProvider: string | null = null
			const options: PluginDependencyOption[] = []

			if (kind === 'base') {
				const baseToken = token
				try {
					const resolver = (this.ctx.registry.container as { resolveIdentifier?: unknown })
						?.resolveIdentifier
					const resolved =
						typeof resolver === 'function'
							? (resolver as (this: unknown, x: unknown) => unknown).call(
									this.ctx.registry.container,
									baseToken,
								)
							: undefined
					if (typeof resolved === 'function') baseProvider = tokenName(resolved)
				} catch {
					// ignore: base providers may not be resolvable in all states.
				}

				for (const [name, pCtor] of this.ctx.loader.api.registry.listRegistered()) {
					try {
						const info = getPluginInfo(pCtor)
						if (info.base !== baseToken) continue
						options.push({
							name,
							isEnabled: this.ctx.configService.isEnabledInConfig(name),
							isRunning: this.ctx.loader.api.runtime.isRunning(pCtor),
						})
					} catch {
						// ignore: some entries may not have complete metadata.
					}
				}
				options.sort((a, b) => a.name.localeCompare(b.name))
			} else if (kind === 'forkable') {
				let originalName: string
				try {
					originalName = getPluginInfo(original as PluginConstructor).id
				} catch {
					originalName = tokenName(original)
				}

				const forkIds: string[] = []
				const fromCatalog =
					this.ctx.configService.getExtra<ForksExtra>(EXTRA_FORKS)?.[originalName] ?? []
				for (const id of fromCatalog) {
					const fid = typeof id === 'string' ? id.trim() : ''
					if (fid) forkIds.push(fid)
				}
				for (const forkCtor of this.ctx.registry.listForks(original as PluginConstructor)) {
					const fid = getForkId(forkCtor)
					if (fid && !forkIds.includes(fid)) forkIds.push(fid)
				}

				options.push({
					name: originalName,
					isEnabled: this.ctx.configService.isEnabledInConfig(originalName),
					isRunning:
						typeof original === 'function'
							? this.ctx.loader.api.runtime.isRunning(original as PluginConstructor)
							: false,
				})
				for (const fid of forkIds) {
					let forkName: string
					try {
						forkName = formatForkPluginId(originalName, fid)
					} catch {
						continue
					}
					const forkCtor = this.ctx.loader.api.runtime.resolve(forkName)
					options.push({
						name: forkName,
						isEnabled: this.ctx.configService.isEnabledInConfig(forkName),
						isRunning: forkCtor ? this.ctx.loader.api.runtime.isRunning(forkCtor) : false,
					})
				}
				options.sort((a, b) => a.name.localeCompare(b.name))
			}

			out.push({
				index: i,
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

	async setDependencyTarget(
		index: number,
		targetName: string | null,
	): Promise<PluginDependencyMutationResult> {
		try {
			const ctor = this.resolveCtor()

			if (!Number.isFinite(index) || index < 0) {
				return { ok: false, code: 'invalid_index', error: `Invalid index: ${index}` }
			}

			const normalized =
				typeof targetName === 'string' && targetName.trim() ? targetName.trim() : null
			writeDepOverride(this.ctx, this.name, index, normalized)

			if (!normalized) {
				clearParamToken(ctor, index)
			} else {
				const token = resolvePlugin(this.ctx, normalized)
				setParamToken(ctor, index, token)

				const fork = parseForkPluginId(normalized)
				if (fork) {
					addForkToCatalog(this.ctx, fork.baseId, fork.forkId)
				}

				// Ensure the selected target is enabled & registered, otherwise DI will fail.
				await this.ctx.loader.api.control.enable(normalized, token)
			}

			this.ctx.registry.restart(ctor)

			const commit = await this.ctx.registry.commit()
			if (commit.err) {
				return { ok: false, code: 'commit_failed', error: String(commit.err) }
			}
			return { ok: true }
		} catch (error) {
			return {
				ok: false,
				code: 'set_dependency_failed',
				error: getErrorMessage(error),
			}
		}
	}

	async setBaseProvider(
		baseToken: string,
		providerName: string | null,
	): Promise<PluginDependencyMutationResult> {
		try {
			const { getExtra, setExtra } = getExtraApi(this.ctx)

			const baseKey = typeof baseToken === 'string' ? baseToken.trim() : ''
			if (!baseKey) return { ok: false, code: 'invalid_base', error: 'baseToken is required' }

			const providers: Array<{
				name: string
				ctor: PluginConstructor
				baseCtor: PluginIdentifier
			}> = []
			for (const [name, pCtor] of this.ctx.loader.api.registry.listRegistered()) {
				try {
					const info = getPluginInfo(pCtor)
					const base = info.base
					if (!base || typeof base !== 'function') continue
					if (getDeclaredName(base) !== baseKey) continue
					providers.push({ name, ctor: pCtor, baseCtor: base })
				} catch {
					// ignore: best-effort scan of registered plugins.
				}
			}
			if (providers.length === 0) {
				return { ok: false, code: 'base_not_found', error: `No providers for base: ${baseKey}` }
			}

			const normalizedProvider =
				typeof providerName === 'string' && providerName.trim() ? providerName.trim() : null

			if (!normalizedProvider) {
				// Clear mapping (does not change runtime immediately).
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

			const target = providers.find((p) => p.name === normalizedProvider)
			if (!target) {
				return {
					ok: false,
					code: 'provider_not_found',
					error: `Provider not found: ${normalizedProvider}`,
				}
			}

			// Persist global default mapping.
			if (typeof getExtra === 'function' && typeof setExtra === 'function') {
				const prev = (getExtra(EXTRA_BASE_PROVIDERS) as BaseProvidersExtra | undefined) ?? {}
				setExtra(EXTRA_BASE_PROVIDERS, { ...prev, [baseKey]: target.name })
			}

			// Reconcile runtime registrations so the selected provider binds the base alias.
			const enabled = [...this.ctx.loader.api.registry.listRegistered()].filter(([name]) =>
				this.ctx.configService.isEnabledInConfig(name),
			)
			for (const [name, ctor] of enabled) this.ctx.loader.api.control.stop(name, ctor)
			for (const [name, ctor] of enabled) await this.ctx.loader.api.control.enable(name, ctor)
			// Ensure selected provider is enabled as well (in case it was disabled).
			if (!enabled.some(([name]) => name === target.name)) {
				await this.ctx.loader.api.control.enable(target.name, target.ctor)
			}

			try {
				this.ctx.registry.restart(target.baseCtor)
			} catch {
				// ignore: base token may not be restartable.
			}

			const commit = await this.ctx.registry.commit()
			if (commit.err) return { ok: false, code: 'commit_failed', error: String(commit.err) }
			return { ok: true }
		} catch (error) {
			return { ok: false, code: 'set_base_failed', error: getErrorMessage(error) }
		}
	}

	async ensureFork(
		baseName: string,
		forkId: string,
		options?: { enable?: boolean },
	): Promise<EnsureForkResult> {
		try {
			const base = typeof baseName === 'string' ? baseName.trim() : ''
			const fid = typeof forkId === 'string' ? forkId.trim() : ''
			if (!base || !fid)
				return { ok: false, code: 'invalid_fork', error: 'baseName/forkId required' }

			const baseCtor = resolvePlugin(this.ctx, base)
			const forkCtor = this.ctx.registry.fork(
				baseCtor as ForkablePluginConstructor,
				fid,
			) as PluginConstructor
			const forkName = getPluginInfo(forkCtor).id

			addForkToCatalog(this.ctx, base, fid)

			if (options?.enable !== false) {
				await this.ctx.loader.api.control.enable(forkName, forkCtor)
			}

			const commit = await this.ctx.registry.commit()
			if (commit.err) return { ok: false, code: 'commit_failed', error: String(commit.err) }
			return { ok: true, forkName }
		} catch (error) {
			return {
				ok: false,
				code: 'ensure_fork_failed',
				error: getErrorMessage(error),
			}
		}
	}

	async baseProvision(): Promise<BaseProvisionInfo | null> {
		const ctor = this.resolveCtor()
		const info = getPluginInfo(ctor)
		const base = info.base
		if (!base || typeof base !== 'function') return null

		const baseToken = getDeclaredName(base)
		const { getExtra } = getExtraApi(this.ctx)
		const map =
			typeof getExtra === 'function'
				? ((getExtra(EXTRA_BASE_PROVIDERS) as BaseProvidersExtra | undefined) ?? {})
				: {}
		const currentDefault = (map?.[baseToken] as string | undefined) ?? null

		const providers: PluginDependencyOption[] = []
		for (const [name, pCtor] of this.ctx.loader.api.registry.listRegistered()) {
			try {
				const pInfo = getPluginInfo(pCtor)
				if (pInfo.base !== base) continue
				providers.push({
					name,
					isEnabled: this.ctx.configService.isEnabledInConfig(name),
					isRunning: this.ctx.loader.api.runtime.isRunning(pCtor),
				})
			} catch {
				// ignore: best-effort scan of registered plugins.
			}
		}
		providers.sort((a, b) => a.name.localeCompare(b.name))

		return {
			baseToken,
			currentDefault,
			isDefault: currentDefault === this.name,
			providers,
		}
	}

	/** 获取插件 schema（源代码形式，用于前端动态构建表单） */
	async schema(): Promise<SchemaResult> {
		const res = await pluginSchema(this.ctx, this.name)
		if (res.ok === false) {
			return { ok: false, code: 'schema_not_found', message: res.message }
		}
		return {
			ok: true,
			schemaSource: res.schemaSource as any,
			defaults: res.defaults as any,
			layout: res.layout ?? null,
		}
	}

	async config(): Promise<ConfigResultOk> {
		const res = await pluginConfigGet(this.ctx, this.name)
		// `config()` is guaranteed-ok; tolerate unexpected failures by returning empty config.
		if (!res.ok) return { ok: true, saved: false, config: {}, defaults: res.defaults ?? {} }
		return { ok: true, saved: false, config: res.config, defaults: res.defaults }
	}

	async validateConfig(patch: ConfigPatch): Promise<ConfigResult> {
		return (await pluginConfigValidate(this.ctx, this.name, (patch ?? {}) as any)) as any
	}

	async saveConfig(patch: ConfigPatch): Promise<ConfigResult> {
		return (await pluginConfigPatch(this.ctx, this.name, (patch ?? {}) as any)) as any
	}

	async saveConfigField(input: ConfigFieldMutation): Promise<ConfigResult> {
		return (await pluginConfigPatchField(this.ctx, this.name, (input ?? {}) as any)) as any
	}

	async resetConfig(keys?: string[]): Promise<ConfigResult> {
		return (await pluginConfigReset(this.ctx, this.name, keys)) as any
	}
}
