// rpc/PluginHandle.ts - 插件操作 RPC
import {
	BasePlugin,
	type Context,
	ForkablePlugin,
	checkPluginDecorator,
	clearParamToken,
	PARAM_TYPES,
	getClassParams,
	getDeclaredName,
	getForkId,
	getForkOf,
	getPluginInfo,
	type PluginConstructor,
	setParamToken,
} from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import * as v from 'valibot'
import { readStatusSnapshot } from '../../features/pluginStatus/service'
import {
	EXTRA_BASE_PROVIDERS,
	EXTRA_DEP_OVERRIDES,
	EXTRA_FORKS,
	type BaseProvidersExtra,
	type DepOverridesExtra,
	type ForksExtra,
} from '../../../services/loader/selection'
import type {
	ConfigPatch,
	ConfigResult,
	ConfigResultOk,
	BaseProvisionInfo,
	EnsureForkResult,
	PluginStatusAction,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
	PluginDependencyKind,
	PluginDependencyMutationResult,
	PluginDependencyOption,
	PluginDependencyState,
	PluginStatusMutationResult,
	SchemaResult,
} from './types'
import { collectDefaults, validateConfigPatch } from './utils'

function resolvePlugin(ctx: Context, name: string, hint?: PluginConstructor): PluginConstructor {
	const ctor =
		ctx.loader.resolveRuntimeCtor(name) ?? ctx.loader.resolveRuntimeCtor(hint ?? name) ?? hint
	if (!ctor) throw new Error(`Plugin not found: ${name}`)
	return ctor
}

function tokenName(token: unknown): string {
	if (typeof token !== 'function') return String(token)
	try {
		return getPluginInfo(token as any).id
	} catch {
		return (token as any)?.name ?? String(token)
	}
}

function readDepOverrides(ctx: Context, consumerName: string): Record<number, string> | undefined {
	const getExtra = (ctx.configService as any)?.getExtra as
		| ((key: string) => unknown)
		| undefined
	if (typeof getExtra !== 'function') return undefined
	const all = getExtra.call(ctx.configService, EXTRA_DEP_OVERRIDES) as DepOverridesExtra | undefined
	return all?.[consumerName]
}

function writeDepOverride(
	ctx: Context,
	consumerName: string,
	index: number,
	targetName: string | null,
) {
	const getExtra = (ctx.configService as any)?.getExtra as
		| ((key: string) => unknown)
		| undefined
	const setExtra = (ctx.configService as any)?.setExtra as
		| ((key: string, value: unknown) => void)
		| undefined
	if (typeof getExtra !== 'function' || typeof setExtra !== 'function') return

	const all =
		(getExtra.call(ctx.configService, EXTRA_DEP_OVERRIDES) as DepOverridesExtra | undefined) ?? {}
	const existing = all[consumerName] ? { ...all[consumerName] } : {}
	if (!targetName) {
		delete existing[index]
	} else {
		existing[index] = targetName
	}
	const nextAll: DepOverridesExtra = { ...all }
	if (Object.keys(existing).length === 0) delete nextAll[consumerName]
	else nextAll[consumerName] = existing
	setExtra.call(ctx.configService, EXTRA_DEP_OVERRIDES, nextAll)
}

function addForkToCatalog(ctx: Context, originalName: string, forkId: string) {
	const getExtra = (ctx.configService as any)?.getExtra as
		| ((key: string) => unknown)
		| undefined
	const setExtra = (ctx.configService as any)?.setExtra as
		| ((key: string, value: unknown) => void)
		| undefined
	if (typeof getExtra !== 'function' || typeof setExtra !== 'function') return

	const all = (getExtra.call(ctx.configService, EXTRA_FORKS) as ForksExtra | undefined) ?? {}
	const prev = Array.isArray(all[originalName]) ? all[originalName] : []
	if (prev.includes(forkId)) return
	setExtra.call(ctx.configService, EXTRA_FORKS, { ...all, [originalName]: [...prev, forkId] })
}

async function runStatusAction(
	ctx: Context,
	name: string,
	action: PluginStatusAction,
): Promise<PluginStatusMutationResult> {
	try {
		const ctor = resolvePlugin(ctx, name)
		const registry = ctx.loader.registry

		switch (action) {
			case 'start':
				await registry.enable(name, ctor)
				break
			case 'stop':
				registry.deactivate(name, ctor, { runtimeOnly: true })
				break
			case 'restart':
				registry.deactivate(name, ctor, { runtimeOnly: true })
				await registry.enable(name, ctor)
				break
			case 'disable':
				registry.deactivate(name, ctor, { runtimeOnly: false })
				break
			case 'enable':
				registry.enablePersisted(name)
				break
			default:
				return { name, ok: false, code: 'invalid_status', error: `Unsupported: ${action}` }
		}
		return { name, ok: true }
	} catch (error) {
		const isStart = action === 'start' || action === 'restart'
		const message = (error as Error)?.message ?? 'Unknown error'
		const code = message.includes('Plugin not found')
			? 'plugin_not_found'
			: isStart
				? 'plugin_start_failed'
				: 'plugin_operation_failed'
		return {
			name,
			ok: false,
			code,
			error: message,
		}
	}
}

export async function applyStatusActions(
	ctx: Context,
	actions: PluginStatusBatchAction[],
): Promise<PluginStatusBatchResult> {
	if (!actions.length) return { ok: true, results: [] }

	const interim: PluginStatusMutationResult[] = []
	const touched = new Set<string>()

	for (const { name, action } of actions) {
		const res = await runStatusAction(ctx, name, action)
		interim.push(res)
		if (res.ok) touched.add(name)
	}

	const commitResult = await ctx.registry.commit()
	if (commitResult.err) {
		const commitError = String(commitResult.err)
		return {
			ok: false,
			commitError,
			results: interim.map((r) =>
				r.ok ? { ...r, ok: false, code: 'commit_failed', error: commitError } : r,
			),
		}
	}

	const snapshots = Array.from(touched).map((name) => {
		const ctor = resolvePlugin(ctx, name)
		return { name, ...readStatusSnapshot(ctx, name, ctor) }
	})
	const snapMap = new Map(snapshots.map((s) => [s.name, s]))

	return {
		ok: interim.every((r) => r.ok),
		results: interim.map((r) => (r.ok ? { ...r, ...snapMap.get(r.name) } : r)),
	}
}

export class PluginHandle extends RpcTarget {
	readonly name: string
	#ctx: Context
	#hint: PluginConstructor

	constructor(ctx: Context, name: string) {
		super()
		this.#ctx = ctx
		this.name = name
		this.#hint = resolvePlugin(ctx, name)
	}

	private resolveCtor(): PluginConstructor {
		return resolvePlugin(this.#ctx, this.name, this.#hint)
	}

	detail() {
		const ctor = this.resolveCtor()
		return {
			name: this.name,
			desc: '插件示例描述',
			dependencies: this.#ctx.loader.getPluginDependenciesInfo(ctor),
		}
	}

	status() {
		const ctor = this.resolveCtor()
		return { name: this.name, ...readStatusSnapshot(this.#ctx, this.name, ctor) }
	}

	async updateStatus(action: PluginStatusAction) {
		const batch = await applyStatusActions(this.#ctx, [{ name: this.name, action }])
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
		const rawParams = ((Reflect as any)?.getMetadata?.(PARAM_TYPES, ctor) as unknown[]) ?? []
		const effectiveParams = getClassParams<unknown>(ctor)
		const overrides = readDepOverrides(this.#ctx, this.name)

		const out: PluginDependencyState[] = []
		for (let i = 0; i < rawParams.length; i++) {
			const token = rawParams[i]
			if (typeof token !== 'function') continue
			const effectiveToken = effectiveParams[i] ?? token

			const effective = tokenName(effectiveToken)
			const selected = overrides?.[i] ?? null

			const isDecorated = checkPluginDecorator(token)
			const isBaseToken = !isDecorated && (token as any).prototype instanceof BasePlugin

			const original = (getForkOf(token as any) as any) ?? token
			const isForkable = (original as any).prototype instanceof ForkablePlugin

			let kind: PluginDependencyKind = 'plugin'
			if (isBaseToken) kind = 'base'
			else if (isForkable) kind = 'forkable'

			const isRunning = this.#ctx.registry.isRunning(effectiveToken as any)
			let baseProvider: string | null = null
			const options: PluginDependencyOption[] = []

			if (kind === 'base') {
				const baseToken = token
				try {
					const resolved = this.#ctx.registry.pluginRegistry.lastContainer?.resolveIdentifier?.(
						baseToken as any,
					) as any
					if (typeof resolved === 'function') baseProvider = tokenName(resolved)
				} catch {}

				for (const [name, pCtor] of this.#ctx.loader.registry.names) {
					try {
						const info = getPluginInfo(pCtor)
						if (info.base !== (baseToken as any)) continue
						options.push({
							name,
							isEnabled: this.#ctx.configService.isEnabledInConfig(name),
							isRunning: this.#ctx.loader.isRunning(pCtor),
						})
					} catch {}
				}
				options.sort((a, b) => a.name.localeCompare(b.name))
			} else if (kind === 'forkable') {
				let originalName: string
				try {
					originalName = getPluginInfo(original as any).id
				} catch {
					originalName = tokenName(original)
				}

				const forkIds: string[] = []
				const fromCatalog = this.#ctx.configService.getExtra<ForksExtra>(EXTRA_FORKS)?.[originalName] ?? []
				for (const id of fromCatalog) {
					const fid = typeof id === 'string' ? id.trim() : ''
					if (fid) forkIds.push(fid)
				}
				for (const forkCtor of this.#ctx.registry.listForks(original as any)) {
					const fid = getForkId(forkCtor as any)
					if (fid && !forkIds.includes(fid)) forkIds.push(fid)
				}

				options.push({
					name: originalName,
					isEnabled: this.#ctx.configService.isEnabledInConfig(originalName),
					isRunning: this.#ctx.loader.isRunning(original as any),
				})
				for (const fid of forkIds) {
					const forkName = `${originalName}#${fid}`
					const forkCtor = this.#ctx.loader.resolveRuntimeCtor(forkName)
					options.push({
						name: forkName,
						isEnabled: this.#ctx.configService.isEnabledInConfig(forkName),
						isRunning: forkCtor ? this.#ctx.loader.isRunning(forkCtor) : false,
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

			const normalized = typeof targetName === 'string' && targetName.trim() ? targetName.trim() : null
			writeDepOverride(this.#ctx, this.name, index, normalized)

			if (!normalized) {
				clearParamToken(ctor, index)
			} else {
				const token = resolvePlugin(this.#ctx, normalized)
				setParamToken(ctor, index, token as any)

				const hash = normalized.lastIndexOf('#')
				if (hash > 0) {
					const baseName = normalized.slice(0, hash)
					const forkId = normalized.slice(hash + 1)
					if (baseName && forkId) addForkToCatalog(this.#ctx, baseName, forkId)
				}

				// Ensure the selected target is enabled & registered, otherwise DI will fail.
				await this.#ctx.loader.registry.enable(normalized, token)
			}

			this.#ctx.registry.pluginRegistry.reloadPlugin(ctor)

			const commit = await this.#ctx.registry.commit()
			if (commit.err) {
				return { ok: false, code: 'commit_failed', error: String(commit.err) }
			}
			return { ok: true }
		} catch (error) {
			return { ok: false, code: 'set_dependency_failed', error: (error as any)?.message ?? String(error) }
		}
	}

	async setBaseProvider(
		baseToken: string,
		providerName: string | null,
	): Promise<PluginDependencyMutationResult> {
		try {
			const getExtra = (this.#ctx.configService as any)?.getExtra as
				| ((key: string) => unknown)
				| undefined
			const setExtra = (this.#ctx.configService as any)?.setExtra as
				| ((key: string, value: unknown) => void)
				| undefined

			const baseKey = typeof baseToken === 'string' ? baseToken.trim() : ''
			if (!baseKey) return { ok: false, code: 'invalid_base', error: 'baseToken is required' }

			const providers: Array<{ name: string; ctor: PluginConstructor; baseCtor: Function }> = []
			for (const [name, pCtor] of this.#ctx.loader.registry.names) {
				try {
					const info = getPluginInfo(pCtor)
					const base = info.base as any as Function | null
					if (!base) continue
					if (getDeclaredName(base) !== baseKey) continue
					providers.push({ name, ctor: pCtor, baseCtor: base })
				} catch {}
			}
			if (providers.length === 0) {
				return { ok: false, code: 'base_not_found', error: `No providers for base: ${baseKey}` }
			}

			const normalizedProvider =
				typeof providerName === 'string' && providerName.trim() ? providerName.trim() : null

			if (!normalizedProvider) {
				// Clear mapping (does not change runtime immediately).
				if (typeof setExtra === 'function') {
					const prev =
						(typeof getExtra === 'function'
							? (getExtra.call(this.#ctx.configService, EXTRA_BASE_PROVIDERS) as BaseProvidersExtra | undefined)
							: undefined) ?? {}
					if (prev[baseKey]) {
						const next = { ...prev }
						delete next[baseKey]
						setExtra.call(this.#ctx.configService, EXTRA_BASE_PROVIDERS, next)
					}
				}
				return { ok: true }
			}

			const target = providers.find((p) => p.name === normalizedProvider)
			if (!target) {
				return { ok: false, code: 'provider_not_found', error: `Provider not found: ${normalizedProvider}` }
			}

			// Persist global default mapping.
			if (typeof setExtra === 'function') {
				const prev =
					typeof getExtra === 'function'
						? ((getExtra.call(this.#ctx.configService, EXTRA_BASE_PROVIDERS) as BaseProvidersExtra | undefined) ??
							{})
						: {}
				setExtra.call(this.#ctx.configService, EXTRA_BASE_PROVIDERS, { ...prev, [baseKey]: target.name })
			}

			// Reconcile runtime registrations so the selected provider binds the base alias.
			const enabled = [...this.#ctx.loader.registry.names].filter(([name]) =>
				this.#ctx.configService.isEnabledInConfig(name),
			)
			for (const [name, ctor] of enabled) this.#ctx.loader.registry.stopPlugin(name, ctor)
			for (const [name, ctor] of enabled) await this.#ctx.loader.registry.enable(name, ctor)
			// Ensure selected provider is enabled as well (in case it was disabled).
			if (!enabled.some(([name]) => name === target.name)) {
				await this.#ctx.loader.registry.enable(target.name, target.ctor)
			}

			try {
				this.#ctx.registry.pluginRegistry.reloadPlugin(target.baseCtor as any)
			} catch {}

			const commit = await this.#ctx.registry.commit()
			if (commit.err) return { ok: false, code: 'commit_failed', error: String(commit.err) }
			return { ok: true }
		} catch (error) {
			return { ok: false, code: 'set_base_failed', error: (error as any)?.message ?? String(error) }
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
			if (!base || !fid) return { ok: false, code: 'invalid_fork', error: 'baseName/forkId required' }

			const baseCtor = resolvePlugin(this.#ctx, base)
			const forkCtor = this.#ctx.registry.fork(baseCtor as any, fid) as PluginConstructor
			const forkName = getPluginInfo(forkCtor).id

			addForkToCatalog(this.#ctx, base, fid)

			if (options?.enable !== false) {
				await this.#ctx.loader.registry.enable(forkName, forkCtor)
			}

			const commit = await this.#ctx.registry.commit()
			if (commit.err) return { ok: false, code: 'commit_failed', error: String(commit.err) }
			return { ok: true, forkName }
		} catch (error) {
			return { ok: false, code: 'ensure_fork_failed', error: (error as any)?.message ?? String(error) }
		}
	}

	async baseProvision(): Promise<BaseProvisionInfo | null> {
		const ctor = this.resolveCtor()
		const info = getPluginInfo(ctor)
		const base = info.base as unknown as Function | null
		if (!base) return null

		const baseToken = getDeclaredName(base)
		const getExtra = (this.#ctx.configService as any)?.getExtra as
			| ((key: string) => unknown)
			| undefined
		const map =
			typeof getExtra === 'function'
				? ((getExtra.call(this.#ctx.configService, EXTRA_BASE_PROVIDERS) as BaseProvidersExtra | undefined) ??
					{})
				: {}
		const currentDefault = (map?.[baseToken] as string | undefined) ?? null

		const providers: PluginDependencyOption[] = []
		for (const [name, pCtor] of this.#ctx.loader.registry.names) {
			try {
				const pInfo = getPluginInfo(pCtor)
				if (pInfo.base !== (base as any)) continue
				providers.push({
					name,
					isEnabled: this.#ctx.configService.isEnabledInConfig(name),
					isRunning: this.#ctx.loader.isRunning(pCtor),
				})
			} catch {}
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
		const ctor = this.resolveCtor()
		const schemaMap = this.#ctx.loader.getPluginSchema(ctor)
		if (!schemaMap) {
			return {
				ok: false,
				code: 'schema_not_found',
				message: 'No config schema registered for this plugin.',
			}
		}

		const schemaSource = this.#ctx.loader.getPluginSchemaSource(ctor)
		if (!schemaSource || Object.keys(schemaSource).length === 0) {
			// schemaSource 为空可能是因为 configSourcePlugin 没有正确注入
			// 这通常发生在 Vite 没有提供 AST 的情况下
			return {
				ok: false,
				code: 'schema_not_found',
				message: `Schema source not available for plugin "${this.name}". Ensure configSourcePlugin is correctly configured and the plugin has @Config decorators.`,
			}
		}

		return {
			ok: true,
			schemaSource,
			defaults: await collectDefaults(schemaMap),
		}
	}

	async config(): Promise<ConfigResultOk> {
		const schema = this.#ctx.loader.getPluginSchema(this.resolveCtor())
		const defaults = await collectDefaults(schema)
		const config = this.#ctx.configService.getConfigSnapshot(this.name).configRecord
		return { ok: true, saved: false, config, defaults }
	}

	async validateConfig(patch: ConfigPatch): Promise<ConfigResult> {
		const schema = this.#ctx.loader.getPluginSchema(this.resolveCtor())
		if (!schema)
			return {
				ok: false,
				code: 'config_not_found',
				message: 'No config schema registered for this plugin.',
			}

		// 并行执行 defaults 收集和验证
		const [defaults, validation] = await Promise.all([
			collectDefaults(schema),
			validateConfigPatch(schema, patch),
		])

		if (!validation.ok) {
			return {
				ok: false,
				code: 'validation_failed',
				errors: validation.errors,
				defaults,
			}
		}

		return {
			ok: true,
			saved: false,
			config: {
				...this.#ctx.configService.getConfigSnapshot(this.name).configRecord,
				...validation.output,
			},
			defaults,
		}
	}

	async saveConfig(patch: ConfigPatch): Promise<ConfigResult> {
		const schema = this.#ctx.loader.getPluginSchema(this.resolveCtor())
		if (!schema)
			return {
				ok: false,
				code: 'config_not_found',
				message: 'No config schema registered for this plugin.',
			}

		// 并行执行 defaults 收集和验证
		const [defaults, validation] = await Promise.all([
			collectDefaults(schema),
			validateConfigPatch(schema, patch),
		])

		if (!validation.ok) {
			return {
				ok: false,
				code: 'validation_failed',
				errors: validation.errors,
				defaults,
			}
		}

		if (Object.keys(validation.output).length > 0) {
			this.#ctx.configService.patchConfigSnapshot(this.name, {
				configRecord: validation.output,
			})
		}

		const config = this.#ctx.configService.getConfigSnapshot(this.name).configRecord
		return { ok: true, saved: true, config, defaults }
	}

	async resetConfig(keys?: string[]): Promise<ConfigResult> {
		const schema = this.#ctx.loader.getPluginSchema(this.resolveCtor())
		if (!schema)
			return {
				ok: false,
				code: 'config_not_found',
				message: 'No config schema registered for this plugin.',
			}

		const targetKeys = keys?.length ? keys : Object.keys(schema)
		const entries = targetKeys
			.map((key) => [key, schema[key]] as const)
			.filter((e): e is [string, NonNullable<(typeof e)[1]>] => e[1] != null)

		// 获取默认值：getDefault 是同步的，只读取静态默认值
		const patch: ConfigPatch = Object.fromEntries(
			entries.map(([key, checker]) => [key, v.getDefault(checker as any) ?? {}]),
		)

		// 并行执行 defaults 收集和验证
		const [defaults, validation] = await Promise.all([
			collectDefaults(schema),
			validateConfigPatch(schema, patch),
		])

		if (!validation.ok) {
			return {
				ok: false,
				code: 'validation_failed',
				errors: validation.errors,
				defaults,
			}
		}

		this.#ctx.configService.patchConfigSnapshot(this.name, { configRecord: validation.output })
		const config = this.#ctx.configService.getConfigSnapshot(this.name).configRecord
		return { ok: true, saved: true, config, defaults }
	}
}
