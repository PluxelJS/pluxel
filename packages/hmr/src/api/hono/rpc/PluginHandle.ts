// rpc/PluginHandle.ts - 插件操作 RPC
import type { Context, PluginConstructor } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import * as v from 'valibot'
import { readStatusSnapshot } from '../../features/pluginStatus/service'
import type {
	ConfigPatch,
	ConfigResult,
	ConfigResultOk,
	PluginStatusAction,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
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
		const config = this.#ctx.configService.getConfig(this.name).configRecord
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
				...this.#ctx.configService.getConfig(this.name).configRecord,
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
			this.#ctx.configService.setConfig(this.name, {
				configRecord: validation.output,
			})
		}

		const config = this.#ctx.configService.getConfig(this.name).configRecord
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

		this.#ctx.configService.setConfig(this.name, { configRecord: validation.output })
		const config = this.#ctx.configService.getConfig(this.name).configRecord
		return { ok: true, saved: true, config, defaults }
	}
}
