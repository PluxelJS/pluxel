import {
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand,
	IconX,
} from '@tabler/icons-react'
import { formatPluginNodeReference } from '@pluxel/core'
import { Tooltip } from '@mantine/core'
import { useWorkbenchState } from '@worksplit/react'
import { useSyncExternalStore } from 'react'
import { builtinPages } from './navigationItems'
import { useWorkspaceSession } from './workspaceContext'
import { useWorkbenchNavigation } from './context'
import { useWorkbenchTargetSnapshot } from '../../workbench/runtime'
import { resolveSidebarShortcut } from './sidebarShortcuts'
import { WorkbenchEntryIcon } from './WorkbenchEntryIcon'

export function ActivityRail({ onShowPlugins }: { onShowPlugins: () => void }) {
	const session = useWorkspaceSession()
	const navigation = useWorkbenchNavigation()
	const snapshot = useWorkbenchTargetSnapshot(null)
	const mode = useWorkbenchState(session.workbench, () => session.navigationMode())
	const active = useWorkbenchState(session.workbench, () => session.workbench.getActiveDocument())
	useSyncExternalStore(session.subscribeContentState, session.getContentRevision)
	const workspace = session.activeWorkspace()
	// Official paths are compared as public hrefs; plugin ownership comes from the rendered document.
	const pathname = active ? new URL(active.href, location.origin).pathname : ''
	const base = session.basepath === '/' ? '' : session.basepath
	const expanded = mode === 'labels'
	useWorkbenchState(session.workbench, (state) => state.revision)
	const shortcuts = session.sidebarShortcuts().map((shortcut) => ({
		shortcut,
		resolved: resolveSidebarShortcut(shortcut, snapshot.layout, snapshot.directory),
	}))
	const shortcutActive = shortcuts.some(
		({ resolved }) => resolved.href !== undefined && active?.href === `${base}${resolved.href}`,
	)
	return (
		<nav className="plx-activity" data-mode={mode} aria-label="工作区入口">
			<div className="plx-activity__items">
				{builtinPages.map(({ href, label, icon: Icon }) => {
					const current =
						href === '/plugins'
							? workspace === 'plugins' || pathname === `${base}/plugins`
							: href === '/apps'
								? (workspace === 'apps' && !shortcutActive) || pathname === `${base}/apps`
								: pathname === `${base}${href}` || (href === '/' && pathname === base)
					return (
						<Tooltip key={href} label={label} position="right" disabled={expanded}>
							<button
								type="button"
								className="plx-activity__item"
								aria-label={label}
								aria-current={current ? 'page' : undefined}
								onClick={href === '/plugins' ? onShowPlugins : () => navigation.navigate(href)}
							>
								<Icon size={20} stroke={1.7} aria-hidden />
								{expanded && <span>{label}</span>}
							</button>
						</Tooltip>
					)
				})}
				{shortcuts.length > 0 && (
					<div className="plx-activity__divider" role="separator" aria-label="已固定应用" />
				)}
				{shortcuts.map(({ shortcut, resolved }) => {
					const href = resolved.href
					const current = href !== undefined && active?.href === `${base}${href}`
					return (
						<div
							key={JSON.stringify([formatPluginNodeReference(shortcut.target), shortcut.entryKey])}
							className="plx-activity__shortcut"
						>
							<Tooltip
								label={
									resolved.unavailable
										? `${resolved.label} · ${resolved.unavailable}`
										: resolved.label
								}
								position="right"
								disabled={expanded && !resolved.unavailable}
							>
								<button
									type="button"
									className="plx-activity__item"
									aria-label={resolved.label}
									aria-current={current ? 'page' : undefined}
									aria-disabled={!href || undefined}
									onClick={() => {
										if (href) navigation.navigate(href)
									}}
								>
									<WorkbenchEntryIcon icon={resolved.icon} />
									{expanded && <span>{resolved.label}</span>}
								</button>
							</Tooltip>
							<button
								type="button"
								className="plx-activity__remove"
								aria-label={`取消侧栏固定 ${resolved.label}`}
								title="取消侧栏固定"
								onClick={() =>
									void session
										.setSidebarShortcut(shortcut, false)
										.catch((error: unknown) => session.report(error))
								}
							>
								<IconX size={12} aria-hidden />
							</button>
						</div>
					)
				})}
			</div>
			<Tooltip label={expanded ? '仅显示图标' : '显示图标与文字'} position="right">
				<button
					type="button"
					className="plx-activity__item plx-activity__mode"
					aria-label={expanded ? '仅显示图标' : '显示图标与文字'}
					aria-pressed={expanded}
					onClick={() =>
						void session
							.setNavigationMode(expanded ? 'icons' : 'labels')
							.catch((error: unknown) => session.report(error))
					}
				>
					{expanded ? (
						<IconLayoutSidebarLeftCollapse size={20} />
					) : (
						<IconLayoutSidebarLeftExpand size={20} />
					)}
					{expanded && <span>仅显示图标</span>}
				</button>
			</Tooltip>
		</nav>
	)
}
