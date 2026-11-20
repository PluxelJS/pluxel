import {
	comparePluginNodeAddress,
	parsePluginNodeAddress,
	pluginNodeIndexKey,
	type PluginNodeAddress,
} from '../plugins/runtime/identity'
import { assertCoreConfigObject } from '../context/core-config-object'
import {
	effectiveOutboundHttpSettings,
	normalizeOutboundHttpSettings,
	type ResolvedOutboundHttpOptions,
} from './options'
import type { OutboundHttpEffectiveSettings, OutboundHttpSettings } from './types'

type NodeSettings = Readonly<{ owner: PluginNodeAddress; settings: OutboundHttpSettings }>

export type OutboundHttpPolicy = Readonly<{
	revision: number
	defaults: OutboundHttpSettings
	nodes: ReadonlyMap<string, NodeSettings>
}>

type ScopePolicy = Readonly<{
	effective: OutboundHttpEffectiveSettings
	origins?: ReadonlySet<string>
}>

export function parseOutboundHttpPolicy(text: string | undefined): OutboundHttpPolicy {
	if (text === undefined) return { revision: 0, defaults: Object.freeze({}), nodes: new Map() }
	const data: unknown = JSON.parse(text)
	assertCoreConfigObject(
		data,
		'[core.http] saved policy',
		new Set(['version', 'revision', 'defaults', 'nodes']),
	)
	const { version, revision, defaults, nodes } = data as Record<string, unknown>
	if (
		version !== 1 ||
		typeof revision !== 'number' ||
		!Number.isSafeInteger(revision) ||
		revision < 0 ||
		!Array.isArray(nodes)
	)
		throw new TypeError('[core.http] unsupported saved policy document')
	const byNode = new Map<string, NodeSettings>()
	for (const entry of nodes as unknown[]) {
		assertCoreConfigObject(entry, '[core.http] saved node', new Set(['owner', 'settings']))
		const { owner: rawOwner, settings } = entry as Record<string, unknown>
		const owner = parsePluginNodeAddress(rawOwner)
		const key = pluginNodeIndexKey(owner)
		if (byNode.has(key)) throw new TypeError('[core.http] duplicate saved node')
		byNode.set(key, { owner, settings: normalizeOutboundHttpSettings(settings) })
	}
	return { revision, defaults: normalizeOutboundHttpSettings(defaults), nodes: byNode }
}

export function serializeOutboundHttpPolicy(policy: OutboundHttpPolicy): string {
	return JSON.stringify({
		version: 1,
		revision: policy.revision,
		defaults: policy.defaults,
		nodes: [...policy.nodes.values()].sort((a, b) => comparePluginNodeAddress(a.owner, b.owner)),
	})
}

export function compileOutboundHttpPolicy(
	options: ResolvedOutboundHttpOptions,
	policy: OutboundHttpPolicy,
) {
	const scope = (settings?: OutboundHttpSettings): ScopePolicy => {
		const effective = effectiveOutboundHttpSettings(options, policy.defaults, settings)
		return {
			effective,
			...(effective.allowedOrigins === undefined
				? {}
				: { origins: new Set(effective.allowedOrigins) }),
		}
	}
	return {
		policy,
		host: scope(),
		nodes: new Map([...policy.nodes].map(([key, value]) => [key, scope(value.settings)])),
	}
}
