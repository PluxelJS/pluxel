import { useWorkbenchState } from '@worksplit/react'
import { Skeleton, Stack } from '@mantine/core'
import { IconPuzzle } from '@tabler/icons-react'
import { memo, useCallback, useMemo, useEffect, useRef } from 'react'
import { EmptyState, ErrorState } from '../../../components'
import { usePluginConfig } from '../config/usePluginConfig'
import { PluginScopeProvider } from './context'
import { RightPane } from './RightPane'
import { useCurrentPathname } from '../../router/useCurrentRoute'
import { parsePluginDetailHref } from '../../../workbench/paths'
import { usePluginDetailSearch } from './pluginDetailSearchState'
import { useDocumentWorkspace, useOptionalWorkbenchDocument } from '../../workbench/document'
import { useOptionalWorkspaceSession } from '../../workbench/workspaceContext'
import { Actions } from 'flexlayout-react'
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
			<PluginDocumentTitle
				session={session}
				documentId={document.id}
				pluginRoute={pluginRoute}
				pluginLabel={pluginLabel}
			/>
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
	documentId,
	pluginRoute,
	pluginLabel,
}: {
	session: NonNullable<ReturnType<typeof useOptionalWorkspaceSession>>
	documentId: string
	pluginRoute: string
	pluginLabel: string
}) {
	const title = useWorkbenchState(
		session.workbench,
		() => session.workbench.getDocument(documentId)?.title,
	)
	const automaticTitle = useRef<{ route: string; label: string } | undefined>(undefined)
	useEffect(() => {
		const previous = automaticTitle.current
		automaticTitle.current = { route: pluginRoute, label: pluginLabel }
		// Native route acceptance may assign its default title after this view mounts.
		// Observe that change, but retain copied/restored or explicitly renamed titles.
		if (
			!title ||
			title === pluginLabel ||
			!(
				title === '插件详情' ||
				title === pluginRoute ||
				(previous?.route === pluginRoute && title === previous.label)
			)
		)
			return
		void session.workbench
			.dispatch(
				Actions.updateNodeAttributes(documentId, {
					name: pluginLabel,
					helpText: pluginRoute,
				}),
			)
			.then((result) => session.check(result))
			.catch((error: unknown) => session.report(error))
	}, [session, documentId, title, pluginRoute, pluginLabel])
	return null
}
