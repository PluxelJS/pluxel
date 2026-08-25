import { useHotkey } from '@tanstack/react-hotkeys'
import {
	IconHome2,
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand,
	IconSearch,
} from '@tabler/icons-react'
import { ColorSchemeToggle } from '../../../theme'
import { useProduct } from '../../product'
import { PluginCatalog } from '../../plugins/catalog/PluginCatalog'
import type { NavSection } from '../../navigation/navConfig'
import { WorkbenchPaneControls } from '../../plugins/detail/controls/WorkbenchPaneControls'
import { RouterLinkAdapter } from '../../RouterLinkAdapter'
import { WorkbenchActionButton } from '../LayoutControls'
import { isWorkbenchActivityActive } from '../location'
import { WORKBENCH_HOTKEYS, WORKBENCH_HOTKEY_LABELS } from '../shortcuts'

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

export function ActivityRail({
	activityItems,
	collapsed,
	onToggleCollapsed,
	pathname,
}: {
	activityItems: NavSection[]
	collapsed: boolean
	onToggleCollapsed: () => void
	pathname: string
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
						<RouterLinkAdapter
							key={`${item.href}:${item.label}`}
							to={item.href}
							className="plx-workbench__activityItem"
							data-active={isActive ? 'true' : 'false'}
							aria-current={isActive ? 'page' : undefined}
							title={item.label}
						>
							<span className="plx-workbench__activityIcon" aria-hidden="true">
								{item.icon ?? <IconHome2 size={18} stroke={1.7} />}
							</span>
							<span className="plx-workbench__activityLabel">{item.label}</span>
						</RouterLinkAdapter>
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

export function RouteGroupRail({ group, pathname }: { group: NavSection; pathname: string }) {
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
						<RouterLinkAdapter
							key={`${item.href}:${item.label}`}
							to={item.href}
							className="plx-workbench__routeGroupItem"
							data-active={isActive ? 'true' : 'false'}
							aria-current={isActive ? 'page' : undefined}
						>
							<span aria-hidden="true">{item.icon}</span>
							<span>{item.label}</span>
						</RouterLinkAdapter>
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

export function PluginNavigationRail({
	onCollapse,
	pluginRoute,
}: {
	onCollapse: () => void
	pluginRoute?: string
}) {
	return (
		<div className="plx-workbench__navigationRail">
			<div className="plx-workbench__navigationBody">
				<PluginCatalog pluginRoute={pluginRoute} onCollapse={onCollapse} />
			</div>
		</div>
	)
}
