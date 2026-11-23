import { Button, Center, Group, Loader, Menu, Text } from '@mantine/core'
import { IconChevronDown, IconSettingsOff } from '@tabler/icons-react'
import { EmptyState, ErrorState } from '../../../components'
import {
	useResolvedWorkbenchRoute,
	useWorkbenchTabs,
	WorkbenchEntryView,
} from '../../../workbench/runtime'
import { DocumentTabs } from '../../workbench/DocumentTabs'
import { useOptionalWorkbenchDocument, useDocumentPlugin } from '../../workbench/document'
import { useCurrentPathname } from '../../router/useCurrentRoute'
import { parsePluginDetailHref, buildPluginDetailHref } from '../../../workbench/paths'
import { WorkbenchRouteRenderer } from '../../router/workbench/WorkbenchRouteRenderer'
import { type PluginConfigState } from '../config/usePluginConfig'
import { ConfigForm } from '../config/ConfigForm'
import { ActionBar } from './controls/ActionBar'
import { usePluginMeta } from './context'
import { usePluginDetailSearch } from './pluginDetailSearchState'
import { useWorkspaceSession } from '../../workbench/workspaceContext'
import { useWorkbenchState } from '@worksplit/react'
import { RouterLinkAdapter } from '../../router/RouterLinkAdapter'
import { buildOutboundHttpNodeHref, PLUGIN_OUTBOUND_HTTP_PATH } from '../../outbound-http/paths'
import { OutboundHttpSettings } from '../../outbound-http/OutboundHttpSettings'

const EMPTY_PARAMS = Object.freeze({})

export function RightPane({ config }: { config: PluginConfigState }) {
	const { owner, pluginLabel } = usePluginMeta()
	const { entries, snapshot } = useWorkbenchTabs(owner)
	const pathname = useCurrentPathname()
	const restPath = parsePluginDetailHref(pathname)?.path ?? ''
	const outboundHttp = restPath === PLUGIN_OUTBOUND_HTTP_PATH
	const isConfig = !restPath || restPath === '/config' || outboundHttp
	const search = usePluginDetailSearch()
	const session = useWorkspaceSession()
	const id = useOptionalWorkbenchDocument()?.id ?? null
	const active = useWorkbenchState(session.workbench, (state) => state.activeDocumentId === id)
	const selectedEntry = search.entry
		? entries.find((candidate) => candidate.descriptor.key === search.entry)
		: undefined
	useDocumentPlugin(isConfig ? owner : undefined, selectedEntry?.descriptor.key)
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
	if (!isConfig)
		return (
			<RouteContent
				target={owner}
				displayName={pluginLabel}
				displayPath={pathname}
				restPath={restPath}
			/>
		)
	return (
		<DocumentTabs
			title={pluginLabel}
			label="插件设置"
			value={outboundHttp ? 'outbound-http' : 'config'}
			sections={[
				{ value: 'config', label: '插件配置', to: buildPluginDetailHref(owner) },
				{ value: 'outbound-http', label: '出站 HTTP', to: buildOutboundHttpNodeHref(owner) },
			]}
			actions={
				<Group gap="sm">
					{entries.length > 0 && (
						<Menu position="bottom-end">
							<Menu.Target>
								<Button
									size="compact-sm"
									variant="default"
									rightSection={<IconChevronDown size={14} aria-hidden />}
								>
									插件页面
								</Button>
							</Menu.Target>
							<Menu.Dropdown>
								{entries.map((entry) => (
									<Menu.Item
										key={entry.descriptor.key}
										component={RouterLinkAdapter}
										to={`${buildPluginDetailHref(owner)}?entry=${encodeURIComponent(entry.descriptor.key)}`}
									>
										{entry.placement.kind === 'tab'
											? (entry.placement.label ?? entry.descriptor.key)
											: entry.descriptor.key}
									</Menu.Item>
								))}
							</Menu.Dropdown>
						</Menu>
					)}
					<ActionBar active={active} />
				</Group>
			}
		>
			{outboundHttp ? (
				<OutboundHttpSettings owner={owner} />
			) : (
				<ConfigContent config={config} owner={owner} displayName={pluginLabel} active={active} />
			)}
		</DocumentTabs>
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
	if (!config.data || !config.data.snapshot || config.data.fields.length === 0)
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
			snapshot={config.data.snapshot}
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
