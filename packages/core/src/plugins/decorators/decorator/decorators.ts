import type { StandardSchemaV1 } from '@standard-schema/spec'
import { isStandardSchemaV1 } from '../../../services/config/standardSchema'
import { BasePlugin } from '../../composition/BasePlugin'
import type { PluginIdentifier, SubclassOf } from '../../types'
import {
	__DEV__,
	$freeze,
	type AnyCtor,
	EMPTY_ARR,
	isSubclassOf,
	nameOf,
	rebuildInfoSnapshot,
	S,
} from './shared'
import {
	type ConfigSchemaList,
	type DeclaredMetaView,
	PARAM_TYPES,
	type PluginMetadata,
} from './types'

/** 收集实例字段配置（@Plugin 统一聚合） */
export function Config(schema: StandardSchemaV1): PropertyDecorator {
	if (!isStandardSchemaV1(schema)) {
		throw new Error(
			'Invalid @Config schema: must implement Standard Schema v1 (~standard.validate).',
		)
	}
	return (target: object, key: string | symbol) => {
		if (typeof target === 'function') throw new Error('@Config 只能用于实例字段(非 static)')
		const ctor = (target as { constructor: AnyCtor }).constructor
		const s = S(ctor)
		const bucket = s.pending ?? Object.create(null)
		bucket[String(key)] = schema
		s.pending = bucket
	}
}

/**
 * 声明插件（可选基类）：
 * - 校验继承关系
 * - 预取 design:paramtypes → rtypes（热路径不再触碰 Reflect）
 * - 聚合 pending @Config → config
 * - 构建对外快照
 */
export function Plugin(meta?: PluginMetadata): ClassDecorator
export function Plugin<B extends PluginIdentifier>(
	base: B,
	meta?: PluginMetadata,
): <C extends SubclassOf<B>>(ctor: C) => void
export function Plugin(a?: PluginMetadata | PluginIdentifier, b?: PluginMetadata) {
	const withBase = typeof a === 'function'
	const base = (withBase ? (a as PluginIdentifier) : null) as PluginIdentifier | null
	const meta = (
		withBase ? ((b as PluginMetadata) ?? {}) : ((a as PluginMetadata) ?? {})
	) as PluginMetadata

	return (ctor: AnyCtor) => {
		if (base) {
			const baseLabel =
				typeof base === 'function' ? nameOf(base as unknown as AnyCtor) : String(base)
			if (!isSubclassOf(base as unknown as AnyCtor, BasePlugin as unknown as AnyCtor)) {
				throw new Error(`@Plugin(${baseLabel}) 失败：抽象基类未继承 BasePlugin`)
			}
			if (!isSubclassOf(ctor, base as unknown as AnyCtor)) {
				throw new Error(`@Plugin(${baseLabel}) 失败：${nameOf(ctor)} 未继承 ${baseLabel}`)
			}
		}

		const s = S(ctor)

		// 预取设计期类型
		const rt = (Reflect.getMetadata(PARAM_TYPES, ctor) as unknown[]) ?? EMPTY_ARR
		s.rtypes = Array.isArray(rt) ? rt : Array.from(rt)

		// 存储 ctor 引用
		s.ctor = ctor as PluginIdentifier

		// 提取并存储 declaredName
		const { name: declaredName, ...restMeta } = meta
		s.declaredName = declaredName || nameOf(ctor)
		s.declaredMeta =
			Object.keys(restMeta).length > 0
				? __DEV__
					? $freeze(restMeta as DeclaredMetaView)
					: (restMeta as DeclaredMetaView)
				: null

		s.base = base

		// 聚合 pending @Config
		if (s.pending && Object.keys(s.pending).length) {
			s.config = __DEV__ ? $freeze(s.pending as ConfigSchemaList) : (s.pending as ConfigSchemaList)
			s.pending = null
		} else {
			s.config = null
		}

		// 构建对外快照
		rebuildInfoSnapshot(ctor, s)
	}
}
