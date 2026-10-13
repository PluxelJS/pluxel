import { Button, Center, Group, Loader, Stack, Text } from '@mantine/core'
import { IconSettingsOff } from '@tabler/icons-react'
import { EmptyState, ErrorState } from '../../../components'
import {
	useResolvedWorkbenchRoute,
	useWorkbenchTabs,
	WorkbenchEntryView,
} from '../../../workbench/runtime'
import { useWorkbenchNavigation } from '../../workbench/context'
import { useOptionalWorkbenchDocument, useDocumentPlugin } from '../../workbench/document'
import { useCurrentPathname } from '../../router/useCurrentRoute'
import { parsePluginDetailHref, buildPluginDetailHref } from '../../../workbench/paths'
import { WorkbenchRouteRenderer } from '../../router/workbench/WorkbenchRouteRenderer'
import type { PluginConfigState } from '../config/usePluginConfig'
import { ConfigForm } from '../config/ConfigForm'
import { ActionBar } from './controls/ActionBar'
import { usePluginMeta } from './context'
import { usePluginDetailSearch } from './pluginDetailSearchState'
import { useWorkspaceSession } from '../../workbench/workspaceContext'
import { useWorkbenchState } from '@worksplit/react'

const EMPTY_PARAMS = Object.freeze({})

export function RightPane({ config }: { config: PluginConfigState }) {
	const { owner, pluginLabel } = usePluginMeta()
	const { entries, snapshot } = useWorkbenchTabs(owner)
	const pathname = useCurrentPathname()
	const restPath = parsePluginDetailHref(pathname)?.path ?? ''
	const search = usePluginDetailSearch()
	const navigation = useWorkbenchNavigation()
	const session = useWorkspaceSession()
	const id = useOptionalWorkbenchDocument()?.id ?? null
	const active = useWorkbenchState(session.workbench, (state) => state.activeDocumentId === id)
	const selectedEntry = search.entry
		? entries.find((candidate) => candidate.descriptor.key === search.entry)
		: undefined
	useDocumentPlugin(
		restPath && restPath !== '/config' ? undefined : owner,
		selectedEntry?.descriptor.key,
	)
	if (search.entry)
		return selectedEntry ? (
			<WorkbenchEntryView
				entry={selectedEntry}
				frame="shell"
				layoutRevision={snapshot.layout?.revision ?? 0}
				params={EMPTY_PARAMS}
			/>
		) : (
			<EmptyState
				title="入口不可用"
				description={`未找到入口：${search.entry}。请检查插件权限和发布状态。`}
			/>
		)
	if (restPath && restPath !== '/config')
		return (
			<RouteContent
				target={owner}
				displayName={pluginLabel}
				displayPath={pathname}
				restPath={restPath}
			/>
		)
	return (
		<Stack gap="sm" h="100%" p="sm" style={{ minHeight: 0 }}>
			<Group justify="space-between">
				<Text fw={600}>{pluginLabel}</Text>
				<ActionBar active={active} />
			</Group>
			{entries.length > 0 && (
				<Group gap="xs" aria-label="插件页面入口">
					{entries.map((entry) => (
						<Button
							key={entry.descriptor.key}
							size="compact-sm"
							variant="light"
							onClick={() =>
								navigation.navigate(
									`${buildPluginDetailHref(owner)}?entry=${encodeURIComponent(entry.descriptor.key)}`,
								)
							}
						>
							{entry.placement.kind === 'tab'
								? (entry.placement.label ?? entry.descriptor.key)
								: entry.descriptor.key}
						</Button>
					))}
				</Group>
			)}
			<div className="plx-pluginDocument__panel">
				<ConfigContent config={config} owner={owner} displayName={pluginLabel} active={active} />
			</div>
		</Stack>
	)
}

function ConfigContent({
	config,
	owner,
	displayName,
	active,
}: {
	config: PluginConfigState
	owner: import('@pluxel/core').PluginNodeAddress
	displayName: string
	active: boolean
}) {
	if (config.error)
		return (
			<ErrorState
				title="加载配置失败"
				message={config.error.message}
				onRetry={() => void config.refetch()}
				minHeight={200}
			/>
		)
	if (config.loading && !config.data)
		return (
			<Center style={{ flex: 1, gap: 8 }}>
				<Loader size="sm" />
				<Text c="dimmed">加载配置中…</Text>
			</Center>
		)
	if (!config.data || config.data.fields.length === 0)
		return (
			<EmptyState
				icon={<IconSettingsOff size={28} />}
				title="暂无可配置项"
				description="该插件未声明可在 Workbench 中编辑的配置。"
				minHeight={200}
			/>
		)
	return (
		<ConfigForm
			owner={owner}
			displayName={displayName}
			fields={config.data.fields}
			savedConfig={config.data.savedConfig}
			defaults={config.data.defaults}
			sections={config.data.sections}
			active={active}
		/>
	)
}

function RouteContent({
	target,
	displayName,
	displayPath,
	restPath,
}: {
	target: import('@pluxel/core').PluginNodeAddress
	displayName: string
	displayPath: string
	restPath: string
}) {
	const { route, snapshot } = useResolvedWorkbenchRoute(target, restPath)
	return (
		<WorkbenchRouteRenderer
			target={target}
			displayName={displayName}
			displayPath={displayPath}
			route={route}
			snapshot={snapshot}
		/>
	)
}
