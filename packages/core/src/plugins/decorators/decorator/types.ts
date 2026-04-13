import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { Identifier } from '../../../container'
import type { PluginIdentifier } from '../../types'
import type { ConfigLayout } from '../../composition/cfg'

/**
 * Canonical DI key for a plugin.
 *
 * Current policy (performance + determinism):
 * - The DI key is always the ctor itself (including forks).
 * - Abstract bases/interfaces are supported via DI aliases (see diod aliasIndex).
 */
export function getPluginDiKey(id: PluginIdentifier): PluginIdentifier {
	return id
}

export interface PluginMetadata {
	/** 声明期 name，可缺省；最终 id 由 Loader 决定 */
	name?: string
	/**
	 * Optional per-plugin lifecycle timeout overrides (milliseconds).
	 * These are read by the runtime registry and only affect this plugin's lifecycle.
	 */
	startTimeoutMs?: number
	stopTimeoutMs?: number
	[key: string]: unknown
}

/** "对外快照"里 meta 字段改名为 metadata，避免与 id/name 冲突 */
export type DeclaredMetaView = Omit<PluginMetadata, 'name'>

export type ConfigSchemaList<T = StandardSchemaV1> = Record<string, T>

/** TS emitDecoratorMetadata 的 key（构造参数类型） */
export const PARAM_TYPES = 'design:paramtypes' as const

/** 稀疏覆盖（数组/对象） */
export type ParamOverride =
	| ReadonlyArray<Identifier<unknown> | undefined>
	| Readonly<Partial<Record<number, Identifier<unknown>>>>

/**
 * 对外快照：PluginInfo
 *
 * 命名语义：
 * - id: 系统唯一标识符，用于 DI 容器注册、配置查找、日志标识
 * - displayName: UI 展示用的人类可读名（可国际化）
 * - declaredName: @Plugin({ name }) 的原始值（不可变）
 * - packageName: 来源包名，用于冲突检测和前缀生成
 */
export interface PluginInfo {
	/** 系统唯一标识符（loader 可设置，默认等于 declaredName） */
	readonly id: string
	/** 显示名（UI/日志用，默认等于 id） */
	readonly displayName: string
	/** 声明期原始名（@Plugin({ name }) 或 ctor.name，不可变） */
	readonly declaredName: string
	/** 来源包名（由 loader 注入） */
	readonly packageName: string | null
	/** 插件类构造函数引用 */
	readonly class: PluginIdentifier
	/** 声明的抽象基类 */
	readonly base: PluginIdentifier | null
	/** 声明期元信息（去掉 name 后的剩余字段） */
	readonly metadata: DeclaredMetaView | null
	/** 由 @Config/configs.use 聚合出的 schema map（null-proto 对象；Standard Schema v1） */
	readonly configMap: ConfigSchemaList<StandardSchemaV1> | null
	/** 由 Vite 插件注入的 @Config 源代码 map（fieldName -> source） */
	readonly configSourceMap: Readonly<Record<string, string>> | null
	/**
	 * Optional config layout (bindingField -> layout parts).
	 *
	 * This is extracted from `this.configs.use(cfg(schemaMap)\`...\`)` by build toolchains and
	 * can be used by hosts to render a custom config page layout.
	 */
	readonly configLayoutMap: Readonly<Record<string, ConfigLayout>> | null
	/**
	 * Config injection bindings (instanceField -> config keys).
	 *
	 * - `field = this.configs.use(schema)` binds `{ [field]: [field] }`
	 * - `field = this.configs.use(cfg\`...\`)` binds `{ [field]: ["a","b",...] }`
	 * - `@Config(schema) declare field` binds `{ [field]: [field] }`
	 */
	readonly configBindingsMap: Readonly<Record<string, readonly string[]>> | null
}
