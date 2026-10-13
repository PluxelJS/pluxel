import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from '@tabler/icons-react'
import { Tooltip } from '@mantine/core'
import { useWorkbenchState } from '@worksplit/react'
import { useSyncExternalStore } from 'react'
import { builtinPages } from './navigationItems'
import { useWorkspaceSession } from './workspaceContext'
import { useWorkbenchNavigation } from './context'

export function ActivityRail({ onShowPlugins }: { onShowPlugins: () => void }) {
	const session = useWorkspaceSession()
	const navigation = useWorkbenchNavigation()
	const mode = useWorkbenchState(session.workbench, () => session.navigationMode())
	const active = useWorkbenchState(session.workbench, () => session.workbench.getActiveDocument())
	useSyncExternalStore(session.subscribeContentState, session.getContentRevision)
	const workspace = session.activeWorkspace()
	// Official paths are compared as public hrefs; plugin ownership comes from the rendered document.
	const pathname = active ? new URL(active.href, location.origin).pathname : ''
	const base = session.basepath === '/' ? '' : session.basepath
	const expanded = mode === 'labels'
	return (
		<nav className="plx-activity" data-mode={mode} aria-label="官方入口">
			<div className="plx-activity__items">
				{builtinPages.map(({ href, label, icon: Icon }) => {
					const current =
						href === '/plugins'
							? workspace === 'plugins' || pathname === `${base}/plugins`
							: href === '/apps'
								? workspace === 'apps' || pathname === `${base}/apps`
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
