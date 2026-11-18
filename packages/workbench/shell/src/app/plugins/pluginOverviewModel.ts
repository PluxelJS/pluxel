import type {
	PluginCatalogSection,
	PluginCatalogSnapshot,
	PluginStatusSnapshot,
	PluginStatePolicy,
} from '@pluxel/services/management/client'
import { pluginDefinitionIndexKey, pluginNodeIndexKey } from '@pluxel/core'
import type { HostInputMode, HostNodePolicyTarget } from '@pluxel/host'

export type PluginStatusEntry = Readonly<
	Omit<PluginStatusSnapshot, 'label'> & {
		/** Canonical catalog identity used by routes and local view state. */
		id: string
		label: string
	}
>

export type PluginOverview = Readonly<{
	statePolicy: PluginStatePolicy
	status: Readonly<{
		statuses: readonly PluginStatusEntry[]
		summary: PluginCatalogSnapshot['summary']
	}>
	sections: readonly PluginCatalogSection[]
}>

function projectStatus(entry: PluginStatusSnapshot): PluginStatusEntry {
	return Object.freeze({ ...entry, id: entry.route, label: entry.label.text })
}

export function buildPluginOverview(catalog: PluginCatalogSnapshot): PluginOverview {
	return Object.freeze({
		statePolicy: catalog.statePolicy,
		status: Object.freeze({
			statuses: Object.freeze(catalog.plugins.map(projectStatus)),
			summary: catalog.summary,
		}),
		sections: Object.freeze([...catalog.sections]),
	})
}

function targetKey(target: HostNodePolicyTarget): string {
	return 'node' in target
		? `${target.field}:${pluginNodeIndexKey(target.node)}`
		: `${target.field}:${pluginNodeIndexKey(target.consumerAddress)}:${pluginDefinitionIndexKey(target.requirementAddress)}`
}

function indexPolicy(policy: PluginStatePolicy) {
	return {
		nodeModes: new Map(policy.nodeModes.map(({ node, mode }) => [pluginNodeIndexKey(node), mode])),
		selections: new Map(
			policy.selections.map((selection) => [targetKey(selection.target), selection]),
		),
	}
}

const policyIndexes = new WeakMap<PluginStatePolicy, ReturnType<typeof indexPolicy>>()

export function readPluginPolicyTarget(
	policy: PluginStatePolicy | undefined,
	target: HostNodePolicyTarget | 'providerDefaults',
) {
	if (!policy) return undefined
	let mode: HostInputMode
	let source: PluginStatePolicy['providerDefaultsSource']
	let shadowed: boolean
	if (target === 'providerDefaults') {
		mode = policy.mode.providerDefaults
		source = policy.providerDefaultsSource
		shadowed = policy.providerDefaultsShadowed
	} else {
		let index = policyIndexes.get(policy)
		if (!index) {
			index = indexPolicy(policy)
			policyIndexes.set(policy, index)
		}
		const node = 'node' in target ? target.node : target.consumerAddress
		const selection = index.selections.get(targetKey(target))
		mode =
			selection?.mode ?? index.nodeModes.get(pluginNodeIndexKey(node)) ?? policy.mode[target.field]
		source = selection?.source ?? 'default'
		shadowed = selection?.shadowed ?? false
	}
	const canWrite =
		!policy.readonly &&
		mode !== 'declared-only' &&
		(mode !== 'declared-first' || source !== 'declared')
	return { mode, source, shadowed, canWrite }
}

export function describePluginPolicyTarget(
	value: ReturnType<typeof readPluginPolicyTarget>,
): string {
	if (!value) return '正在读取运行策略'
	const source = { declared: '宿主声明', saved: '保存输入', default: '默认值' }[value.source]
	const shadowed = value.shadowed ? ' · 保存值被覆盖' : ''
	return `${value.mode} · ${source}${shadowed} · ${value.canWrite ? '可修改' : '生效值不可修改'}`
}

const LIFECYCLE_FAILURES = new Set<string>([
	'resolve-failed',
	'config-failed',
	'start-failed',
	'dependency-blocked',
	'drain-failed',
])

export type PluginAttention = Readonly<{
	tone: 'error' | 'pending'
	label: '运行异常' | '依赖阻塞' | '装配问题' | '不可用' | '等待启动'
	message: string | null
}>

/** Why a Plugin needs an operator's attention, or `null` when its runtime facts agree. */
export function pluginAttention(
	plugin: Pick<PluginStatusEntry, 'issues' | 'availability' | 'desiredState' | 'lifecycleState'>,
): PluginAttention | null {
	const failure = plugin.issues.find((issue) => LIFECYCLE_FAILURES.has(issue.code))
	if (failure)
		return {
			tone: 'error',
			label: failure.code === 'dependency-blocked' ? '依赖阻塞' : '运行异常',
			message: failure.message,
		}
	if (plugin.availability === 'unavailable')
		return { tone: 'error', label: '不可用', message: plugin.issues[0]?.message ?? null }
	if (plugin.issues[0])
		return { tone: 'error', label: '装配问题', message: plugin.issues[0].message }
	if (plugin.desiredState === 'running' && plugin.lifecycleState !== 'running')
		return { tone: 'pending', label: '等待启动', message: null }
	return null
}
