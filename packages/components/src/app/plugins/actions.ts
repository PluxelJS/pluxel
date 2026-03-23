import type {
	HmrRpcApi,
	PluginStatusAction,
	PluginStatusBatchAction,
	PluginStatusBatchResult,
	PluginStatusMutationResult,
} from '@pluxel/runtime/web/ui'
import type { RpcStub } from 'capnweb'
import { invokeRpc } from '../rpc'
import { getPluginOverviewSnapshot, requestPluginOverviewRefetch } from './data'
import { invalidate } from '../data/invalidations'

export type StartPlanOptions = {
	includeTargets?: boolean
	requireConfiguredFor?: 'all' | 'dependencies' | 'none'
	includeRunningTargets?: boolean
}

export type StartPlan = {
	order: string[]
	blockedByConfig: string[]
	missing: string[]
	alreadyRunning: string[]
}

export type StartResult = { name: string; ok: boolean; error?: string }

export type StatusActionResult = StartResult & {
	isRunning?: PluginStatusMutationResult['isRunning']
	isEnabled?: PluginStatusMutationResult['isEnabled']
	lifecycleStage?: PluginStatusMutationResult['lifecycleStage']
}

type HmrRpcStub = RpcStub<HmrRpcApi>

async function readStatusOverviewSnapshot() {
	let snapshot = getPluginOverviewSnapshot()
	if (!snapshot.hasSnapshot || !snapshot.overview) {
		try {
			await requestPluginOverviewRefetch()
		} catch {}
		snapshot = getPluginOverviewSnapshot()
	}
	return snapshot.overview?.status?.statuses ?? []
}

async function isPluginConfigured(rpc: HmrRpcStub, name: string) {
	try {
		const plugin = rpc.plugin(name)
		const [schemaResult, configResult] = await Promise.allSettled([
			plugin.schema(),
			plugin.config(),
		])

		// 没有 schema 视为“无需配置”，允许级联
		const schemaMissing =
			schemaResult.status === 'fulfilled' &&
			schemaResult.value?.ok === false &&
			schemaResult.value.code === 'schema_not_found'
		if (schemaMissing) return true

		// schema 拉取异常时保守处理：阻止自动启动
		const schemaLoaded = schemaResult.status === 'fulfilled' && schemaResult.value?.ok !== false
		if (!schemaLoaded) return false

		const configRecord =
			configResult.status === 'fulfilled' && configResult.value?.ok
				? (configResult.value.config ?? {})
				: {}
		return Object.keys(configRecord).length > 0
	} catch {
		return false
	}
}

export async function buildStartPlan(
	targets: string[],
	options: StartPlanOptions = {},
): Promise<StartPlan> {
	return invokeRpc(async (rpc) => {
		const roots = Array.from(new Set(targets.filter(Boolean)))
		if (roots.length === 0) {
			return { order: [], blockedByConfig: [], missing: [], alreadyRunning: [] }
		}

		const includeTargets = options.includeTargets ?? true
		const includeRunningTargets = options.includeRunningTargets ?? false
		const requireConfiguredFor = options.requireConfiguredFor ?? 'dependencies'
		const rootsSet = new Set(roots)

		// 拉取依赖链；失败的记为 maybeMissing，但不提前跳过，后面用状态快照再判定
		const depMap = new Map<string, string[]>()
		const maybeMissing = new Set<string>()
		const detailVisited = new Set<string>()
		const queue = [...roots]
		while (queue.length > 0) {
			const name = queue.shift()!
			if (detailVisited.has(name)) continue
			detailVisited.add(name)
			try {
				const detail = (await rpc.plugin(name).detail()) as {
					dependencies?: Array<{ name?: string; optional?: boolean }>
				} | null
				const deps = (detail?.dependencies ?? [])
					.filter((d: any) => !d?.optional)
					.map((d: any) => (typeof d?.name === 'string' ? d.name.trim() : ''))
					.filter(Boolean)
				depMap.set(name, deps)
				for (const dep of deps) {
					if (!detailVisited.has(dep)) queue.push(dep)
				}
			} catch {
				maybeMissing.add(name)
				depMap.set(name, [])
			}
		}

		// 运行态快照
		const available = new Set<string>()
		const running = new Set<string>()
		try {
			const statuses = await readStatusOverviewSnapshot()
			for (const entry of statuses ?? []) {
				if (typeof entry?.name !== 'string') continue
				available.add(entry.name)
				if (entry?.isRunning) running.add(entry.name)
			}
		} catch {
			// ignore snapshot errors; treat as all stopped
		}
		const missing = new Set([...maybeMissing].filter((name) => !available.has(name)))

		// 计算启动顺序：深度优先，依赖优先
		const startOrder: string[] = []
		const touchSet = new Set<string>()
		const visited = new Set<string>()
		const visiting = new Set<string>()
		const traverse = (name: string) => {
			if (visiting.has(name) || visited.has(name)) {
				touchSet.add(name)
				return
			}
			visiting.add(name)
			touchSet.add(name)
			const deps = depMap.get(name) ?? []
			for (const dep of deps) traverse(dep)
			visiting.delete(name)
			visited.add(name)
			const forceInclude = includeRunningTargets && rootsSet.has(name)
			const shouldInclude =
				(includeTargets || !rootsSet.has(name)) && (!running.has(name) || forceInclude)
			if (shouldInclude) startOrder.push(name)
		}

		if (includeTargets) {
			for (const root of roots) traverse(root)
		} else {
			for (const root of roots) {
				const deps = depMap.get(root) ?? []
				for (const dep of deps) traverse(dep)
			}
		}

		// 配置就绪性检查：默认仅校验依赖，根插件交由用户决策
		const needConfigCheck =
			requireConfiguredFor === 'none'
				? []
				: startOrder.filter((name) => (requireConfiguredFor === 'all' ? true : !rootsSet.has(name)))

		const blockedByConfig: string[] = []
		if (needConfigCheck.length > 0) {
			const configEntries = await Promise.all(
				needConfigCheck.map(async (name) => [name, await isPluginConfigured(rpc, name)] as const),
			)
			for (const [name, ready] of configEntries) {
				if (!ready) blockedByConfig.push(name)
			}
		}

		const uniqueOrder = startOrder.filter(
			(name, idx) => startOrder.indexOf(name) === idx && !missing.has(name),
		)
		const finalOrder = uniqueOrder.slice()
		if (includeTargets) {
			for (const root of roots) {
				if (missing.has(root)) continue
				if (!includeRunningTargets && running.has(root)) continue
				if (!finalOrder.includes(root)) finalOrder.push(root)
			}
		}

		return {
			order: finalOrder,
			blockedByConfig,
			missing: Array.from(missing),
			alreadyRunning: [...running].filter((name) => touchSet.has(name)),
		}
	})
}

function normalizeBatchResults(
	payload: PluginStatusBatchResult,
	fallbackError?: string,
): StatusActionResult[] {
	const base = payload?.results ?? []
	const commitError = payload?.commitError ?? fallbackError
	if (!base.length) return []

	return base.map((item: PluginStatusMutationResult) => {
		const ok = Boolean(item?.ok) && !commitError
		return {
			name: item?.name ?? '',
			ok,
			error: ok ? undefined : (item?.error ?? commitError ?? item?.code ?? '未知错误'),
			isRunning: item?.isRunning,
			isEnabled: item?.isEnabled,
			lifecycleStage: item?.lifecycleStage,
		}
	})
}

export async function updatePluginStatuses(
	actions: PluginStatusBatchAction[],
): Promise<StatusActionResult[]> {
	if (!actions.length) return []
	try {
		return await invokeRpc(async (rpc) => {
			const result = await rpc.updatePluginStatuses(actions)
			const normalized = normalizeBatchResults(result)
			if (normalized.length === 0 && result?.commitError) {
				return actions.map((action) => ({
					name: action.name,
					ok: false,
					error: result.commitError ?? '未知错误',
				}))
			}
			const succeeded = normalized
				.map((item, idx) => ({ item, action: actions[idx] }))
				.filter((entry) => entry.item?.ok)
			if (succeeded.length > 0) {
				const first = succeeded[0]?.action
				invalidate({
					topic: 'plugin-status',
					pluginName: succeeded.length === 1 ? first?.name : undefined,
					reason:
						succeeded.length === 1 && first ? first.action : 'batch',
				})
			}
			return normalized
		})
	} catch (error: any) {
		return actions.map((action) => ({
			name: action.name,
			ok: false,
			error: error?.message ?? '请求失败',
		}))
	}
}

export async function executeStartPlan(
	order: string[],
	targetAction: PluginStatusAction = 'start',
): Promise<StatusActionResult[]> {
	if (order.length === 0) return []
	const actions = order.map((name, idx) => ({
		name,
		action: idx === order.length - 1 ? targetAction : ('start' as PluginStatusAction),
	}))
	return updatePluginStatuses(actions)
}
