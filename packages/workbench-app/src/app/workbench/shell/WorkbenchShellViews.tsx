import { useHotkey } from '@tanstack/react-hotkeys'
import { Link, Outlet } from '@tanstack/react-router'
import {
	IconExternalLink,
	IconHome2,
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand,
	IconSearch,
	IconX,
} from '@tabler/icons-react'
import { ColorSchemeToggle } from '../../../theme'
import { useProduct } from '../../product'
import { PluginCatalog } from '../../plugins/catalog/PluginCatalog'
import type { NavSection } from '../../navigation/navConfig'
import { WorkbenchPaneControls } from '../../plugins/detail/controls/WorkbenchPaneControls'
import { WorkbenchActionButton } from '../LayoutControls'
import type { WorkbenchNavigationMode } from '../context'
import { isWorkbenchActivityActive } from '../location'
import { WORKBENCH_HOTKEYS, WORKBENCH_HOTKEY_LABELS } from '../shortcuts'
import type { WorkbenchTab } from '../state'

export function WorkbenchHotkeys({
	canTogglePluginRail,
	onCloseActiveTab,
	onFocusSearch,
	onNextTab,
	onPrevTab,
	onTogglePluginRail,
}: {
	canTogglePluginRail: boolean
	onCloseActiveTab: () => void
	onFocusSearch: () => void
	onNextTab: () => void
	onPrevTab: () => void
	onTogglePluginRail: () => void
}): null {
	useHotkey(
		WORKBENCH_HOTKEYS.togglePluginRail,
		() => {
			if (canTogglePluginRail) onTogglePluginRail()
		},
		{ ignoreInputs: true, preventDefault: true },
	)
	useHotkey(WORKBENCH_HOTKEYS.focusSearch, onFocusSearch, {
		ignoreInputs: true,
		preventDefault: true,
	})
	useHotkey(WORKBENCH_HOTKEYS.closeActiveTab, onCloseActiveTab, {
		ignoreInputs: true,
		preventDefault: true,
	})
	useHotkey(WORKBENCH_HOTKEYS.prevTab as never, onPrevTab, {
		ignoreInputs: true,
		preventDefault: true,
	})
	useHotkey(WORKBENCH_HOTKEYS.nextTab as never, onNextTab, {
		ignoreInputs: true,
		preventDefault: true,
	})
	return null
}

type RequestNavigation = (to: string, request?: WorkbenchNavigationMode | 'auto') => string

export function ActivityRail({
	activityItems,
	collapsed,
	onToggleCollapsed,
	pathname,
	requestNavigation,
}: {
	activityItems: NavSection[]
	collapsed: boolean
	onToggleCollapsed: () => void
	pathname: string
	requestNavigation: RequestNavigation
}) {
	const product = useProduct()
	return (
		<aside className="plx-workbench__activity" aria-label="工作台导航">
			<div className="plx-workbench__activityBrand">
				<ColorSchemeToggle
					label="切换工作台明暗模式"
					variant="subtle"
					size={34}
					radius="sm"
					className="plx-workbench__activityBrandMark"
				/>
				<span className="plx-workbench__activityBrandText">
					<strong>{product?.displayName ?? 'Pluxel'}</strong>
					<small>{product?.publisher ?? '点击图标切换主题'}</small>
				</span>
			</div>

			<nav className="plx-workbench__activityList">
				{activityItems.map((item) => {
					const isActive = item.children?.length
						? item.children.some((child) =>
								isWorkbenchActivityActive(pathname, child.href, child.exact),
							)
						: isWorkbenchActivityActive(pathname, item.href, item.exact)
					return (
						<Link
							key={`${item.href}:${item.label}`}
							to={item.href}
							className="plx-workbench__activityItem"
							onClick={() => requestNavigation(item.href, 'auto')}
							data-active={isActive ? 'true' : 'false'}
							aria-current={isActive ? 'page' : undefined}
							title={item.label}
						>
							<span className="plx-workbench__activityIcon" aria-hidden="true">
								{item.icon ?? <IconHome2 size={18} stroke={1.7} />}
							</span>
							<span className="plx-workbench__activityLabel">{item.label}</span>
						</Link>
					)
				})}
			</nav>

			<div className="plx-workbench__activityFooter">
				{product && (product.copyright || (product.legalLinks?.length ?? 0) > 0) ? (
					<div className="plx-workbench__productLegal">
						{product.copyright ? <small>{product.copyright}</small> : null}
						{product.legalLinks?.length ? (
							<nav aria-label={`${product.displayName} 法律信息`}>
								{product.legalLinks.map((link, index) => (
									<a
										key={`${index}:${link.label}:${link.href}`}
										href={link.href}
										{...(isExternalHref(link.href)
											? { target: '_blank', rel: 'noreferrer noopener' }
											: {})}
									>
										{link.label}
									</a>
								))}
							</nav>
						) : null}
					</div>
				) : null}
				<button
					type="button"
					className="plx-workbench__navigationToggle"
					onClick={onToggleCollapsed}
					aria-label={collapsed ? '展开主导航' : '收起主导航为仅图标'}
					title={collapsed ? '展开导航' : '收起为仅图标'}
				>
					{collapsed ? (
						<IconLayoutSidebarLeftExpand size={18} stroke={1.7} />
					) : (
						<IconLayoutSidebarLeftCollapse size={18} stroke={1.7} />
					)}
					<span>{collapsed ? '展开导航' : '仅显示图标'}</span>
				</button>
			</div>
		</aside>
	)
}

function isExternalHref(href: string): boolean {
	return !href.startsWith('/')
}

export function RouteGroupRail({
	group,
	pathname,
	openTab,
	requestNavigation,
}: {
	group: NavSection
	pathname: string
	openTab: (input: { to: string; title: string; meta?: string }) => void
	requestNavigation: RequestNavigation
}) {
	return (
		<aside className="plx-workbench__routeGroup" aria-label={`${group.label} 导航`}>
			<div className="plx-workbench__routeGroupHeader">
				<span className="plx-workbench__routeGroupIcon" aria-hidden="true">
					{group.icon}
				</span>
				<strong>{group.label}</strong>
			</div>
			<nav className="plx-workbench__routeGroupList">
				{group.children?.map((item) => {
					const isActive = isWorkbenchActivityActive(pathname, item.href, item.exact)
					return (
						<div key={`${item.href}:${item.label}`} className="plx-workbench__routeGroupItemRow">
							<Link
								to={item.href}
								className="plx-workbench__routeGroupItem"
								data-active={isActive ? 'true' : 'false'}
								aria-current={isActive ? 'page' : undefined}
								onClick={() => requestNavigation(item.href, 'auto')}
							>
								<span aria-hidden="true">{item.icon}</span>
								<span>{item.label}</span>
							</Link>
							<button
								type="button"
								className="plx-workbench__routeGroupItemOpen"
								aria-label={`在新工作标签打开 ${item.label}`}
								title="在新工作标签打开"
								onClick={() => openTab({ to: item.href, title: item.label, meta: group.label })}
							>
								<IconExternalLink size={14} stroke={1.8} />
							</button>
						</div>
					)
				})}
			</nav>
		</aside>
	)
}

export function PluginTopbarActions({
	focusWorkbenchSearch,
	isPluginDetail,
	togglePluginNav,
}: {
	focusWorkbenchSearch: () => void
	isPluginDetail: boolean
	togglePluginNav: () => void
}) {
	return (
		<>
			{isPluginDetail ? (
				<WorkbenchActionButton
					className="plx-workbench__action"
					label="插件列表"
					onClick={togglePluginNav}
					title={`切换插件列表 (${WORKBENCH_HOTKEY_LABELS.togglePluginRail})`}
				>
					<IconLayoutSidebarLeftCollapse size={16} stroke={1.8} />
					<span className="plx-workbench__actionLabel">插件列表</span>
					<span className="plx-workbench__actionHint">
						{WORKBENCH_HOTKEY_LABELS.togglePluginRail}
					</span>
				</WorkbenchActionButton>
			) : null}
			<WorkbenchActionButton
				className="plx-workbench__action"
				label="打开插件"
				onClick={focusWorkbenchSearch}
				title={`打开插件搜索 (${WORKBENCH_HOTKEY_LABELS.focusSearch})`}
			>
				<IconSearch size={16} stroke={1.8} />
				<span className="plx-workbench__actionLabel">打开插件</span>
				<span className="plx-workbench__actionHint">{WORKBENCH_HOTKEY_LABELS.focusSearch}</span>
			</WorkbenchActionButton>
			{isPluginDetail ? <WorkbenchPaneControls /> : null}
		</>
	)
}

export function EditorTabStrip({
	activeTabId,
	dirtyTabs,
	onActivateTab,
	onCloseTab,
	tabs,
}: {
	activeTabId: string | null
	dirtyTabs: Record<string, boolean>
	onActivateTab: (tab: WorkbenchTab) => void
	onCloseTab: (tabId: string) => void
	tabs: WorkbenchTab[]
}) {
	return (
		<div className="plx-workbench__editorTabStrip" role="tablist" aria-label="工作标签页">
			{tabs.map((tab) => {
				const isActive = tab.id === activeTabId
				const isDirty = Boolean(dirtyTabs[tab.id])
				return (
					<div
						key={tab.id}
						className="plx-workbench__editorTabButton"
						data-active={isActive ? 'true' : 'false'}
						role="tab"
						aria-selected={isActive}
						tabIndex={0}
						onClick={() => onActivateTab(tab)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								event.preventDefault()
								onActivateTab(tab)
							}
						}}
					>
						<div className="plx-workbench__editorTabBody">
							<span className="plx-workbench__editorTabTitle">{tab.title}</span>
							{isDirty ? (
								<span
									className="plx-workbench__editorTabDirtyDot"
									title="未保存更改"
									aria-hidden="true"
								/>
							) : null}
							{tab.meta ? <span className="plx-workbench__editorTabMeta">{tab.meta}</span> : null}
						</div>
						<button
							type="button"
							className="plx-workbench__iconButton"
							aria-label={`关闭 ${tab.title}`}
							onClick={(event) => {
								event.stopPropagation()
								onCloseTab(tab.id)
							}}
						>
							<IconX size={14} stroke={1.8} />
						</button>
					</div>
				)
			})}
		</div>
	)
}

export function PluginNavigationRail({
	onCollapse,
	pluginName,
}: {
	onCollapse: () => void
	pluginName?: string
}) {
	return (
		<div className="plx-workbench__navigationRail">
			<div className="plx-workbench__navigationBody">
				<PluginCatalog pluginName={pluginName} onCollapse={onCollapse} />
			</div>
		</div>
	)
}

export function WorkspacePaneContent() {
	return (
		<div className="plx-workbench__workspace">
			<div className="plx-workbench__workspaceContent">
				<Outlet />
			</div>
		</div>
	)
}
