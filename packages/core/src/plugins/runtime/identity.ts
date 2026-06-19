import { getPluginInfo } from '../decorators/PluginDecorator'
import type { PluginConstructor, PluginIdentifier } from '../types'
import { getForkId, getForkOf } from './fork'
import { parseForkPluginId } from './pluginId'

export type PluginName = string
export type ForkId = string

/**
 * Canonical runtime identity for plugin graph nodes, runtime caches, lifecycle
 * summaries, and watcher indexing.
 *
 * Constructors remain authoring/compatibility tokens. They are resolved to this
 * key at declaration, planning, or read-model boundaries.
 */
export type RuntimePluginKey = PluginName | `${PluginName}#${ForkId}`

/** Structured form used at module/control-plane boundaries before string canonicalization. */
export type PluginIdentity = {
	name: PluginName
	fork?: ForkId
}

/** Accepted input handle while legacy constructor APIs are still supported. */
export type RuntimePluginHandle = PluginIdentifier | RuntimePluginKey

export function runtimePluginKeyOfIdentity(identity: PluginIdentity): RuntimePluginKey {
	return identity.fork
		? (`${identity.name}#${identity.fork}` as RuntimePluginKey)
		: (identity.name as RuntimePluginKey)
}

export function parseRuntimePluginKey(key: RuntimePluginKey): PluginIdentity {
	const fork = parseForkPluginId(key)
	if (fork) return { name: fork.baseId, fork: fork.forkId }
	return { name: key }
}

export function runtimePluginKeyOfName(name: string): RuntimePluginKey {
	return name as RuntimePluginKey
}

export function runtimePluginKeyOfCtor(ctor: PluginIdentifier): RuntimePluginKey {
	const info = getPluginInfo(ctor as PluginConstructor)
	const forkId = getForkId(ctor)
	if (!forkId) return info.id as RuntimePluginKey

	const base = getForkOf(ctor)
	if (!base) return info.id as RuntimePluginKey
	const baseInfo = getPluginInfo(base as PluginConstructor)
	return runtimePluginKeyOfIdentity({ name: baseInfo.id, fork: forkId })
}
