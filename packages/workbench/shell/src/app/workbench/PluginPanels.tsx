import {
	IconApi,
	IconBrandDiscord,
	IconBrandTelegram,
	IconBuilding,
	IconChartBar,
	IconCloudUpload,
	IconHistory,
	IconMessageChatbot,
	IconPlugConnected,
	IconReceipt,
	IconSearch,
	IconSettings,
	IconShieldLock,
	IconTestPipe,
	IconTextRecognition,
	IconTypography,
	IconUsers,
} from '@tabler/icons-react'
import { Alert, Tabs } from '@mantine/core'
import { formatPluginNodeRoute, pluginNodeAddressEqual, pluginNodeIndexKey } from '@pluxel/core'
import { useWorkbenchState } from '@worksplit/react'
import { Actions, Model, TabNode } from 'flexlayout-react'
import { useSyncExternalStore, type ReactNode } from 'react'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import {
	WorkbenchEntryView,
	useWorkbenchRuntime,
	useWorkbenchTargetSnapshot,
} from '../../workbench/runtime'
import { useWorkspaceSession } from './workspaceContext'

const panelIcons = {
	api: IconApi,
	'brand-discord': IconBrandDiscord,
	'brand-telegram': IconBrandTelegram,
	building: IconBuilding,
	'chart-bar': IconChartBar,
	'cloud-upload': IconCloudUpload,
	history: IconHistory,
	'message-chatbot': IconMessageChatbot,
	'plug-connected': IconPlugConnected,
	receipt: IconReceipt,
	search: IconSearch,
	settings: IconSettings,
	'shield-lock': IconShieldLock,
	'test-pipe': IconTestPipe,
	'text-recognition': IconTextRecognition,
	typography: IconTypography,
	users: IconUsers,
}

const EMPTY_PARAMS = Object.freeze({})
type Region = 'left' | 'right' | 'bottom'
type Builtin = { value: string; label: string; content: ReactNode }
type PanelEntry = WorkbenchLayoutEntry & {
	placement: Extract<WorkbenchLayoutEntry['placement'], { kind: 'panel' }>
}
const toolIds = { left: 'navigation', right: 'plugin-inspector', bottom: 'plugin-logs' } as const

/** Region tabs select content, while the single native model owns all docking geometry. */
export function PluginRegionTabs({
	region,
	builtins,
	keepBuiltinMounted = false,
}: {
	region: Region
	builtins: readonly Builtin[]
	keepBuiltinMounted?: boolean
}) {
	const session = useWorkspaceSession()
	useSyncExternalStore(session.subscribeContentState, session.getContentRevision)
	const activeId = useWorkbenchState(session.workbench, (state) => state.activeDocumentId)
	const owner = activeId ? session.documents.get(activeId)?.plugin : undefined
	const snapshot = useWorkbenchTargetSnapshot(owner ?? null)
	const host = useWorkbenchRuntime()
	const toolId = toolIds[region]
	const visible = useWorkbenchState(session.workbench, () => session.isToolVisible(toolId))
	const requested = useWorkbenchState(session.workbench, () => {
		if (region === 'left') return session.navigationView()
		const node = Model.fromJson(session.workbench.getLayout()).getNodeById(toolId)
		return node instanceof TabNode && typeof node.getConfig()?.panelView === 'string'
			? (node.getConfig().panelView as string)
			: builtins[0]?.value
	})
	const entries = (snapshot.layout?.entries ?? [])
		.filter(
			(entry): entry is PanelEntry =>
				entry.placement.kind === 'panel' &&
				entry.placement.region === region &&
				!!owner &&
				pluginNodeAddressEqual(entry.target.node, owner),
		)
		.sort(
			(a, b) =>
				a.placement.order - b.placement.order || a.placement.label.localeCompare(b.placement.label),
		)
	const panelValue = (entry: PanelEntry) =>
		`panel:${formatPluginNodeRoute(entry.target.node)}:${entry.descriptor.key}` as const
	const selected =
		builtins.some((item) => item.value === requested) ||
		entries.some((entry) => panelValue(entry) === requested)
			? requested
			: (builtins[0]?.value ?? (entries[0] ? panelValue(entries[0]) : null))
	const selectedEntry = entries.find((entry) => panelValue(entry) === selected)
	const running =
		!!owner && (!host.runningPluginsReady || host.runningPluginKeys.has(pluginNodeIndexKey(owner)))
	const select = async (value: string) => {
		if (region === 'left') {
			if (value === 'plugins' || value.startsWith('panel:'))
				await session.setNavigationView(value as 'plugins' | `panel:${string}`)
			return
		}
		const node = Model.fromJson(session.workbench.getLayout()).getNodeById(toolId)
		if (!(node instanceof TabNode)) return
		session.check(
			await session.workbench.dispatch(
				Actions.updateNodeAttributes(toolId, {
					config: { ...node.getConfig(), panelView: value },
				}),
			),
		)
	}
	return (
		<Tabs
			value={selected}
			onChange={(value) => {
				if (value) void select(value).catch((error) => session.report(error))
			}}
			className="plx-plugin-region"
			keepMounted={keepBuiltinMounted}
			keepMountedMode="display-none"
		>
			{builtins.length + entries.length > 1 && (
				<Tabs.List
					className="plx-plugin-region__tabs"
					aria-label={
						region === 'left' ? '插件导航' : region === 'right' ? '插件信息视图' : '插件底部视图'
					}
				>
					{builtins.map((item) => (
						<Tabs.Tab key={item.value} value={item.value}>
							{item.label}
						</Tabs.Tab>
					))}
					{entries.map((entry) => {
						const Icon = entry.placement.icon ? panelIcons[entry.placement.icon] : undefined
						return (
							<Tabs.Tab
								key={panelValue(entry)}
								value={panelValue(entry)}
								title={entry.placement.label}
								leftSection={Icon ? <Icon size={13} aria-hidden /> : undefined}
							>
								{entry.placement.label}
							</Tabs.Tab>
						)
					})}
				</Tabs.List>
			)}
			{builtins.map((item) => (
				<Tabs.Panel key={item.value} value={item.value} className="plx-plugin-region__content">
					{(keepBuiltinMounted || selected === item.value) && item.content}
				</Tabs.Panel>
			))}
			{selectedEntry && (
				<Tabs.Panel
					value={panelValue(selectedEntry)}
					className="plx-plugin-region__content plx-plugin-region__extension"
				>
					{visible &&
						!!session.activeWorkspace() &&
						(running ? (
							<WorkbenchEntryView
								key={panelValue(selectedEntry)}
								entry={selectedEntry}
								frame="shell"
								layoutRevision={snapshot.layout?.revision ?? 0}
								params={EMPTY_PARAMS}
							/>
						) : (
							<Alert color="gray" title="插件未运行">
								启动当前插件后可使用此面板。
							</Alert>
						))}
				</Tabs.Panel>
			)}
			{snapshot.error && (
				<Alert color="red" title="插件面板读取失败">
					{snapshot.error.message}
				</Alert>
			)}
		</Tabs>
	)
}
