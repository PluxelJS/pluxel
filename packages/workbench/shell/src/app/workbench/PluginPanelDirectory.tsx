import { Alert, Button, Group, Stack, Text } from '@mantine/core'
import { pluginNodeAddressEqual, pluginNodeIndexKey } from '@pluxel/core'
import type { WorkbenchLayoutEntry } from '@pluxel/workbench/client'
import { useWorkbenchState } from '@worksplit/react'
import { useSyncExternalStore } from 'react'
import { useWorkbenchRuntime, useWorkbenchTargetSnapshot } from '../../workbench/runtime'
import type { WorkspaceSession } from './session'
import { useOptionalWorkspaceSession } from './workspaceContext'

export type PluginPanelEntry = WorkbenchLayoutEntry & {
	placement: Extract<WorkbenchLayoutEntry['placement'], { kind: 'panel' }>
}
export const panelRegionLabels = { left: '左侧', right: '右侧', bottom: '底部' } as const

/** Discovery uses the current publication, never cached declarations from a stopped owner. */
export function usePluginPanelDirectory(session: WorkspaceSession) {
	useWorkbenchState(session.workbench, (state) => state.revision)
	const activeId = useWorkbenchState(session.workbench, (state) => state.activeDocumentId)
	useSyncExternalStore(session.subscribeContentState, session.getContentRevision)
	const owner = activeId ? session.documents.get(activeId)?.plugin : undefined
	const snapshot = useWorkbenchTargetSnapshot(owner ?? null)
	const runtime = useWorkbenchRuntime()
	const running =
		!!owner &&
		(!runtime.runningPluginsReady || runtime.runningPluginKeys.has(pluginNodeIndexKey(owner)))
	const entries = owner
		? (snapshot.layout?.entries ?? [])
				.filter(
					(entry): entry is PluginPanelEntry =>
						entry.placement.kind === 'panel' && pluginNodeAddressEqual(entry.target.node, owner),
				)
				.toSorted(
					(a, b) =>
						a.placement.order - b.placement.order ||
						a.placement.label.localeCompare(b.placement.label),
				)
		: []
	return { owner, entries, running, snapshot, session }
}
export type PluginPanelDirectoryState = ReturnType<typeof usePluginPanelDirectory>

export function panelUnavailable(entry: PluginPanelEntry, running: boolean): string | undefined {
	if (!running) return '插件未运行'
	if (!('federatedViewUnavailable' in entry) || !entry.federatedViewUnavailable) return undefined
	return entry.federatedViewUnavailable.reason === 'building' ? '构建中' : '构建失败'
}

export function PluginPanelDirectory() {
	const session = useOptionalWorkspaceSession()
	return session ? <ConnectedDirectory session={session} /> : null
}
function ConnectedDirectory({ session }: { session: WorkspaceSession }) {
	const directory = usePluginPanelDirectory(session)
	if (!directory.owner) return null
	return (
		<Stack gap="xs" component="section" aria-label="插件扩展">
			<Text size="sm" fw={600}>
				插件扩展
			</Text>
			{directory.snapshot.error ? (
				<Alert color="red" title="扩展读取失败">
					{directory.snapshot.error.message}
				</Alert>
			) : null}
			{directory.snapshot.state === 'loading' ? (
				<Text size="xs" c="dimmed" role="status">
					正在读取扩展…
				</Text>
			) : null}
			{!directory.entries.length && directory.snapshot.state === 'ready' ? (
				<Text size="xs" c="dimmed">
					当前插件没有可用扩展
				</Text>
			) : null}
			{directory.entries.map((entry) => {
				const unavailable = panelUnavailable(entry, directory.running)
				const opened = session.isPanelOpen(entry)
				return (
					<Group key={entry.descriptor.key} justify="space-between" gap="xs" wrap="nowrap">
						<Stack gap={0} style={{ minWidth: 0 }}>
							<Text size="sm" truncate="end" title={entry.placement.label}>
								{entry.placement.label}
							</Text>
							<Text size="xs" c="dimmed">
								{panelRegionLabels[entry.placement.region]}
								{opened ? ' · 已打开' : ''}
							</Text>
						</Stack>
						<Button
							size="compact-xs"
							variant="subtle"
							disabled={!!unavailable}
							aria-label={`${unavailable ?? (opened ? '显示' : '打开')} ${entry.placement.label}`}
							onClick={() => {
								void session.openPanel(entry).catch((error) => session.report(error))
							}}
						>
							{unavailable ?? (opened ? '显示' : '打开')}
						</Button>
					</Group>
				)
			})}
		</Stack>
	)
}
