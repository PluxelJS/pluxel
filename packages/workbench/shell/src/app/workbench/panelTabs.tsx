import { Alert } from '@mantine/core'
import {
	formatPluginNodeReference,
	parsePluginNodeReference,
	pluginNodeAddressEqual,
	pluginNodeIndexKey,
} from '@pluxel/core'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import { useWorkbenchState } from '@worksplit/react'
import { useSyncExternalStore } from 'react'
import type { IJsonTabNode } from 'flexlayout-react'
import {
	WorkbenchEntryView,
	useWorkbenchRuntime,
	useWorkbenchTargetSnapshot,
} from '../../workbench/runtime'
import { useWorkspaceSession } from './workspaceContext'

export type PanelRegion = 'left' | 'right' | 'bottom'
export type PanelIdentity = { owner: string; key: string; region: PanelRegion }
export function panelTabId(owner: string, key: string) {
	return `plugin-panel:${JSON.stringify([owner, key])}`
}
export function panelIdentity(entry: WorkbenchLayoutEntry): PanelIdentity {
	if (entry.placement.kind !== 'panel') throw new Error('该扩展不是侧栏面板')
	return {
		owner: formatPluginNodeReference(entry.target.node),
		key: entry.descriptor.key,
		region: entry.placement.region,
	}
}
export function readPanelIdentity(tab: IJsonTabNode): PanelIdentity | undefined {
	if (!tab.id?.startsWith('plugin-panel:')) return undefined
	const value = tab.config?.pluginPanel as Partial<PanelIdentity> | undefined
	if (
		!value ||
		typeof value.owner !== 'string' ||
		typeof value.key !== 'string' ||
		!value.key ||
		!['left', 'right', 'bottom'].includes(value.region as string)
	)
		throw new Error('插件面板布局身份无效')
	const owner = formatPluginNodeReference(parsePluginNodeReference(value.owner))
	if (owner !== value.owner || tab.id !== panelTabId(owner, value.key))
		throw new Error('插件面板布局引用不一致')
	return { owner, key: value.key, region: value.region as PanelRegion }
}
export function panelTab(entry: WorkbenchLayoutEntry): IJsonTabNode {
	const identity = panelIdentity(entry)
	if (entry.placement.kind !== 'panel') throw new Error('该扩展不是侧栏面板')
	return {
		type: 'tab',
		id: panelTabId(identity.owner, identity.key),
		name: entry.placement.label,
		component: 'worksplit.tool',
		config: { pluginPanel: identity },
		enableClose: true,
		enableDrag: true,
		enableRename: false,
		enablePin: false,
		enableFloat: false,
		enablePopout: false,
		minHeight: 0,
	}
}
export function resolvePanelTool(tab: IJsonTabNode) {
	const identity = readPanelIdentity(tab)
	return identity
		? { id: tab.id!, render: () => <PluginPanel identity={identity} id={tab.id!} /> }
		: undefined
}
const EMPTY_PARAMS = Object.freeze({})
function PluginPanel({ identity, id }: { identity: PanelIdentity; id: string }) {
	const session = useWorkspaceSession()
	useSyncExternalStore(session.subscribeContentState, session.getContentRevision)
	const activeId = useWorkbenchState(session.workbench, (state) => state.activeDocumentId)
	const visible = useWorkbenchState(session.workbench, () => session.isToolVisible(id))
	const activeOwner = activeId ? session.documents.get(activeId)?.plugin : undefined
	const owner = parsePluginNodeReference(identity.owner)
	const snapshot = useWorkbenchTargetSnapshot(owner)
	const runtime = useWorkbenchRuntime()
	if (!visible || !activeOwner || !pluginNodeAddressEqual(activeOwner, owner)) return null
	if (snapshot.error)
		return (
			<Alert color="red" title="插件面板读取失败">
				{snapshot.error.message}
			</Alert>
		)
	const entry = snapshot.layout?.entries.find(
		(item) =>
			item.descriptor.key === identity.key &&
			pluginNodeAddressEqual(item.target.node, owner) &&
			item.placement.kind === 'panel' &&
			item.placement.region === identity.region,
	)
	if (!entry)
		return (
			<Alert color="gray" title="面板暂不可用">
				当前插件尚未发布此面板。可以关闭它，并从插件信息的扩展面板列表重新打开可用面板。
			</Alert>
		)
	if (runtime.runningPluginsReady && !runtime.runningPluginKeys.has(pluginNodeIndexKey(owner)))
		return (
			<Alert color="gray" title="插件未运行">
				启动当前插件后可使用此面板。
			</Alert>
		)
	return (
		<div
			className="plx-plugin-region__extension"
			style={{ height: '100%', minHeight: 0, overflow: 'auto' }}
		>
			<WorkbenchEntryView
				entry={entry}
				frame="shell"
				layoutRevision={snapshot.layout?.revision ?? 0}
				params={EMPTY_PARAMS}
			/>
		</div>
	)
}
