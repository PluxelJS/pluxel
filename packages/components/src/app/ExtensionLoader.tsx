// packages/components/src/app/ExtensionLoader.tsx
/**
 * 扩展加载器组件
 *
 * 负责从后端获取扩展清单并加载插件 UI 模块
 */

import { useEffect, useMemo } from 'react'
import { useExtensionManager, type PluginInfo } from '../extension'
import { fetchExtensionManifest } from '../extension/api/manifest'
import { useQuery } from './gqty'
import { subscribePluginStatusEvents } from './plugins/statusEvents'

interface ExtensionLoaderProps {
	/** 轮询间隔（毫秒），0 表示不轮询 */
	pollInterval?: number
	/** 运行中插件集合变化回调 */
	onRunningPluginsChange?: (plugins: ReadonlySet<string>) => void
}

/**
 * 扩展加载器
 *
 * 订阅插件状态变化，自动加载/卸载插件 UI 扩展
 */
export function ExtensionLoader({ pollInterval = 5000, onRunningPluginsChange }: ExtensionLoaderProps) {
	const query = useQuery({
		refetchOnWindowVisible: false,
		fetchInBackground: true,
		prepare: ({ query }) => {
			// 显式访问需要的字段，让 gqty 知道要获取哪些数据
			query.pluginStatus?.statuses?.forEach((status) => {
				status?.name
				status?.isRunning
			})
		},
	})

	// 获取所有插件状态
	const pluginStatuses = query.pluginStatus?.statuses ?? []

	// 转换为 PluginInfo 格式（使用稳定的 key 生成）
	const plugins: PluginInfo[] = useMemo(() => {
		return pluginStatuses
			.filter(
				(entry): entry is NonNullable<typeof entry> & { name: string } =>
					typeof entry?.name === 'string' && entry.name.trim().length > 0,
			)
			.map((entry) => ({
				name: entry.name.trim(),
				isRunning: Boolean(entry.isRunning),
			}))
	}, [pluginStatuses])

	useEffect(() => {
		if (!onRunningPluginsChange) return
		const next = new Set<string>()
		for (const plugin of plugins) {
			if (plugin.isRunning && plugin.name) {
				next.add(plugin.name)
			}
		}
		onRunningPluginsChange(next)
	}, [plugins, onRunningPluginsChange])

	useEffect(() => {
		let inflight = false
		let pending = false
		const triggerRefetch = () => {
			if (inflight) {
				pending = true
				return
			}
			inflight = true
			void query.$refetch(true).finally(() => {
				inflight = false
				if (pending) {
					pending = false
					triggerRefetch()
				}
			})
		}
		return subscribePluginStatusEvents(triggerRefetch)
	}, [query.$refetch])

	// 使用扩展管理器
	useExtensionManager(plugins, {
		fetchManifest: fetchExtensionManifest,
		pollInterval,
	})

	// 此组件不渲染任何 UI
	return null
}

/**
 * 简化版扩展加载 Hook（不依赖 GraphQL）
 *
 * 适用于不使用 gqty 的场景
 */
export function useSimpleExtensionLoader(
	runningPlugins: string[],
	options: { pollInterval?: number } = {},
) {
	const { pollInterval = 5000 } = options

	const plugins: PluginInfo[] = useMemo(() => {
		return runningPlugins.map((name) => ({
			name,
			isRunning: true,
		}))
	}, [runningPlugins])

	return useExtensionManager(plugins, {
		fetchManifest: fetchExtensionManifest,
		pollInterval,
	})
}
