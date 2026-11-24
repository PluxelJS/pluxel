import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand } from '@tabler/icons-react'
import { Tooltip } from '@mantine/core'
import { useWorkbenchState } from '@worksplit/react'
import { Fragment, useSyncExternalStore } from 'react'
import { appsPage, builtinPages } from './navigationItems'
import { useWorkspaceSession } from './workspaceContext'
import { useWorkbenchTargetSnapshot } from '../../workbench/runtime'
import { resolveWorkbenchEntryLink, sidebarShortcutId } from '../../workbench/entry-link'
import { WorkbenchEntryIcon } from './WorkbenchEntryIcon'
import { RouterLinkAdapter } from '../router/RouterLinkAdapter'

const railPages = [
	...builtinPages.filter((page) => page !== appsPage && page.href !== '/security/audit'),
	appsPage,
]

export function ActivityRail({ onShowPlugins }: { onShowPlugins: () => void }) {
	const session = useWorkspaceSession()
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
		resolved: resolveWorkbenchEntryLink(shortcut, snapshot),
	}))
	const shortcutActive = shortcuts.some(
		({ resolved }) => resolved.href !== undefined && active?.href === `${base}${resolved.href}`,
	)
	return (
		<nav className="plx-activity" data-mode={mode} aria-label="工作区入口">
			<div className="plx-activity__items">
				{railPages.map(({ href, label, icon: Icon }) => {
					const path = `${base}${href}`
					const current =
						href === '/plugins'
							? workspace === 'plugins' || pathname === `${base}/plugins`
							: href === '/apps'
								? (workspace === 'apps' && !shortcutActive) || pathname === `${base}/apps`
								: pathname === path ||
									(href === '/' ? pathname === base : pathname.startsWith(`${path}/`))
					const props = {
						className: 'plx-activity__item',
						'aria-label': label,
						'aria-current': current ? ('page' as const) : undefined,
					}
					const content = (
						<>
							<Icon size={20} stroke={1.7} aria-hidden />
							{expanded && <span>{label}</span>}
						</>
					)
					return (
						<Fragment key={href}>
							{href === '/apps' && (
								<div className="plx-activity__divider" role="separator" aria-label="应用入口" />
							)}
							<Tooltip label={label} position="right" disabled={expanded}>
								{href === '/plugins' ? (
									<button type="button" {...props} onClick={onShowPlugins}>
										{content}
									</button>
								) : (
									<RouterLinkAdapter to={href} {...props}>
										{content}
									</RouterLinkAdapter>
								)}
							</Tooltip>
						</Fragment>
					)
				})}
				{shortcuts.map(({ shortcut, resolved }) => {
					const href = resolved.href
					const current = href !== undefined && active?.href === `${base}${href}`
					const props = {
						className: 'plx-activity__item',
						'aria-label': resolved.label,
						'aria-current': current ? ('page' as const) : undefined,
					}
					const content = (
						<>
							<WorkbenchEntryIcon icon={resolved.icon} />
							{expanded && <span>{resolved.label}</span>}
						</>
					)
					return (
						<Tooltip
							key={sidebarShortcutId(shortcut)}
							label={
								resolved.unavailable
									? `${resolved.label} · ${resolved.unavailable}`
									: resolved.label
							}
							position="right"
							disabled={expanded && !resolved.unavailable}
						>
							{href ? (
								<RouterLinkAdapter to={href} {...props}>
									{content}
								</RouterLinkAdapter>
							) : (
								<button type="button" {...props} aria-disabled="true">
									{content}
								</button>
							)}
						</Tooltip>
					)
				})}
			</div>
			<Tooltip label="显示图标与文字" position="right" disabled={expanded}>
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
