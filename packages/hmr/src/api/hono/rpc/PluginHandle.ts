// rpc/PluginHandle.ts - 插件操作 RPC
import type { Context, PluginConstructor } from '@pluxel/core'
import { RpcTarget } from 'capnweb'
import { getDefault } from 'valibot'
import { readStatusSnapshot } from '../../features/pluginStatus/service'
import type {
	ConfigPatch,
	ConfigResult,
	ConfigResultOk,
	PluginStatusAction,
	SchemaResult,
} from './types'
import { collectDefaults, validateConfigPatch } from './utils'

function resolvePlugin(ctx: Context, name: string, hint?: PluginConstructor): PluginConstructor {
	const ctor =
		ctx.loader.resolveRuntimeCtor(name) ?? ctx.loader.resolveRuntimeCtor(hint ?? name) ?? hint
	if (!ctor) throw new Error(`Plugin not found: ${name}`)
	return ctor
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
		const ctor = this.resolveCtor()
		const registry = this.#ctx.loader.registry
		const snapshot = () => readStatusSnapshot(this.#ctx, this.name, ctor)

		try {
			switch (action) {
				case 'start':
					registry.enable(this.name, ctor)
					break
				case 'stop':
					registry.deactivate(this.name, ctor, { runtimeOnly: true })
					break
				case 'restart':
					registry.deactivate(this.name, ctor, { runtimeOnly: true })
					registry.enable(this.name, ctor)
					break
				case 'disable':
					registry.deactivate(this.name, ctor, { runtimeOnly: false })
					break
				case 'enable':
					registry.enablePersisted(this.name)
					break
				default:
					return {
						ok: false as const,
						code: 'invalid_status',
						error: `Unsupported status: ${action}`,
						...snapshot(),
					}
			}

			const result = await this.#ctx.registry.commit()
			if (result.err) {
				return {
					ok: false as const,
					code: 'commit_failed',
					error: String(result.err),
					...snapshot(),
				}
			}

			return { ok: true as const, ...snapshot() }
		} catch (error) {
			const isStart = action === 'start' || action === 'restart'
			return {
				ok: false as const,
				code: isStart ? 'plugin_start_failed' : 'plugin_operation_failed',
				error: (error as Error)?.message ?? 'Unknown error',
				...snapshot(),
			}
		}
	}

	/** 获取插件 schema（源代码形式，用于前端动态构建表单） */
	schema(): SchemaResult {
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
			defaults: collectDefaults(schemaMap),
		}
	}

	config(): ConfigResultOk {
		const schema = this.#ctx.loader.getPluginSchema(this.resolveCtor())
		const defaults = collectDefaults(schema)
		const config = this.#ctx.configService.getConfig(this.name).configRecord
		return { ok: true, saved: false, config, defaults }
	}

	validateConfig(patch: ConfigPatch): ConfigResult {
		const schema = this.#ctx.loader.getPluginSchema(this.resolveCtor())
		if (!schema)
			return {
				ok: false,
				code: 'config_not_found',
				message: 'No config schema registered for this plugin.',
			}

		const defaults = collectDefaults(schema)
		const validation = validateConfigPatch(schema, patch)
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

	saveConfig(patch: ConfigPatch): ConfigResult {
		const schema = this.#ctx.loader.getPluginSchema(this.resolveCtor())
		if (!schema)
			return {
				ok: false,
				code: 'config_not_found',
				message: 'No config schema registered for this plugin.',
			}

		const defaults = collectDefaults(schema)
		const validation = validateConfigPatch(schema, patch)
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

	resetConfig(keys?: string[]): ConfigResult {
		const schema = this.#ctx.loader.getPluginSchema(this.resolveCtor())
		if (!schema)
			return {
				ok: false,
				code: 'config_not_found',
				message: 'No config schema registered for this plugin.',
			}

		const targetKeys = keys?.length ? keys : Object.keys(schema)
		const patch: ConfigPatch = {}
		for (const key of targetKeys) {
			const checker = schema[key]
			if (!checker) continue
			patch[key] = getDefault(checker as any) ?? {}
		}

		const defaults = collectDefaults(schema)
		const validation = validateConfigPatch(schema, patch)
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
