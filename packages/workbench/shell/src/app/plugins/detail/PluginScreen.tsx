import { Skeleton, Stack } from '@mantine/core'
import { IconPuzzle } from '@tabler/icons-react'
import { memo, useCallback, useMemo, useLayoutEffect } from 'react'
import { EmptyState, ErrorState } from '../../../components'
import { usePluginConfig } from '../config/usePluginConfig'
import { PluginScopeProvider } from './context'
import { RightPane } from './RightPane'
import { useCurrentPathname } from '../../router/useCurrentRoute'
import { parsePluginDetailHref } from '../../../workbench/paths'
import { usePluginDetailSearch } from './pluginDetailSearchState'
import { useDocumentWorkspace, useOptionalWorkbenchDocument } from '../../workbench/document'
import { useOptionalWorkspaceSession } from '../../workbench/workspaceContext'
import { usePluginDetail } from './usePluginDetail'

function PluginSkeleton() {
	return (
		<Stack p="md">
			<Skeleton h={24} w="40%" />
			<Skeleton h={120} />
			<Skeleton h={240} />
		</Stack>
	)
}

export interface PluginScreenProps {
	pluginRoute: string
}

export const PluginScreen = memo(function PluginScreen({ pluginRoute }: PluginScreenProps) {
	const pathname = useCurrentPathname()
	const search = usePluginDetailSearch()
	const restPath = parsePluginDetailHref(pathname)?.path ?? ''
	useDocumentWorkspace(search.entry || (restPath && restPath !== '/config') ? 'apps' : 'plugins')
	const {
		detail,
		ready,
		listed,
		hasStatusSnapshot,
		statusEntry,
		dependencyGraph,
		error,
		loading,
		refetch,
	} = usePluginDetail(pluginRoute)
	const pluginLabel = detail?.label ?? pluginRoute
	const description = detail?.desc ?? ''
	const document = useOptionalWorkbenchDocument()
	const session = useOptionalWorkspaceSession()
	const titleSync =
		document && session && detail && !search.entry && (!restPath || restPath === '/config') ? (
			<PluginDocumentTitle session={session} pluginRoute={pluginRoute} pluginLabel={pluginLabel} />
		) : null

	const owner = detail?.address
	const configState = usePluginConfig(ready ? owner : undefined)

	const handleRefetch = useCallback(async () => {
		await refetch()
	}, [refetch])

	const contextValue = useMemo(() => {
		if (!detail || !owner || !statusEntry) return null
		return {
			owner,
			pluginRoute,
			pluginLabel,
			description,
			dependencyGraph,
			status: statusEntry,
			refetch: handleRefetch,
		}
	}, [
		dependencyGraph,
		description,
		pluginLabel,
		owner,
		pluginRoute,
		handleRefetch,
		statusEntry,
		detail,
	])

	if (!pluginRoute) {
		return (
			<EmptyState
				icon={<IconPuzzle size={28} stroke={1.5} />}
				title="请选择一个插件"
				description="从左侧列表选择插件以查看详情。"
				minHeight="100%"
			/>
		)
	}

	if (pluginRoute && hasStatusSnapshot && !listed && !loading) {
		return (
			<EmptyState
				icon={<IconPuzzle size={28} stroke={1.5} />}
				title="插件不存在"
				description={`未找到插件：${pluginRoute}`}
				minHeight="100%"
			/>
		)
	}

	if (error && !ready) {
		return (
			<ErrorState
				title="加载失败"
				message={error.message || '无法加载插件详情，请重试'}
				onRetry={() => void refetch()}
				minHeight="100%"
			/>
		)
	}

	if (!ready)
		return (
			<>
				{titleSync}
				<PluginSkeleton />
			</>
		)
	if (!contextValue) return titleSync

	return (
		<PluginScopeProvider value={contextValue}>
			{titleSync}
			<div className="plx-pluginDocument">
				<RightPane config={configState} />
			</div>
		</PluginScopeProvider>
	)
})

function PluginDocumentTitle({
	session,
	pluginRoute,
	pluginLabel,
}: {
	session: NonNullable<ReturnType<typeof useOptionalWorkspaceSession>>
	pluginRoute: string
	pluginLabel: string
}) {
	const document = useOptionalWorkbenchDocument()!
	useLayoutEffect(() => {
		const state = document.state
		const previous = state.title
		state.title = pluginLabel
		session.notifyContentState()
		return () => {
			if (state.title === pluginLabel) state.title = previous
			session.notifyContentState()
		}
	}, [session, document.state, pluginRoute, pluginLabel])
	return null
}
