import { readPanelIdentity } from './panelTabs'
import { NumberInput } from '@mantine/core'
import {
	IconCheck,
	IconDots,
	IconFile,
	IconLayoutColumns,
	IconPin,
	IconX,
} from '@tabler/icons-react'
import {
	Actions,
	BorderNode,
	ContextMenuBuilder,
	DockLocation,
	GroupAction,
	I18nLabel,
	I18nLabelDefaults,
	PopupMenu,
	TabGroupNode,
	TabNode,
	TabSetNode,
	type Action,
	type IPopupMenuItem,
	type IPopupMenuItemApi,
	type Node,
	type NodeContextAction,
	type PopupMenuEntry,
} from 'flexlayout-react'
import {
	useCallback,
	useEffect,
	useMemo,
	useState,
	type KeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	type RefObject,
} from 'react'
import type { WorkbenchProps } from '@worksplit/react'
import type { WorkspaceSession } from './session'

type MenuNode = TabNode | TabGroupNode | TabSetNode | BorderNode
type OpenMenu = {
	node: MenuNode
	parent: ReturnType<Node['getParent']>
	targets?: readonly TabNode[]
	anchor: HTMLElement | { x: number; y: number }
	returnFocusTo: HTMLElement
	items: PopupMenuEntry[]
	title: string
}

const labels: Partial<Record<I18nLabel, string>> = {
	[I18nLabel.Close_Tab]: '关闭标签',
	[I18nLabel.Pinned_Tab]: '已固定',
	[I18nLabel.Rename_Tab]: '重命名标签',
	[I18nLabel.Close_Tabset]: '关闭整个标签容器',
	[I18nLabel.Active_Tabset]: '当前标签容器',
	[I18nLabel.Move_Tabset]: '移动标签容器',
	[I18nLabel.Move_Tabs]: '移动 ? 个标签',
	[I18nLabel.Move_Group]: '移动分组（? 个标签）',
	[I18nLabel.Maximize]: '最大化标签容器',
	[I18nLabel.Restore]: '还原标签容器',
	[I18nLabel.Overflow_Menu_Tooltip]: '查看溢出标签',
	[I18nLabel.Splitter]: '调整分隔线',
	[I18nLabel.Error_rendering_component]: '页面呈现失败',
	[I18nLabel.Error_rendering_component_retry]: '重试',
	[I18nLabel.Menu_Rename]: '重命名标签',
	[I18nLabel.Menu_Pin]: '固定标签（分组中的标签会移出分组）',
	[I18nLabel.Menu_Unpin]: '取消固定标签',
	[I18nLabel.Menu_Maximize]: '最大化标签容器',
	[I18nLabel.Menu_Restore]: '还原标签容器',
	[I18nLabel.Menu_Overlay]: '边栏悬浮显示',
	[I18nLabel.Menu_Split]: '边栏停靠显示',
	[I18nLabel.Menu_Close_All]: '关闭可见且可关闭标签',
	[I18nLabel.Menu_Close_Right]: '关闭右侧可见标签',
	[I18nLabel.Menu_Close_Others]: '关闭其他可见标签',
	[I18nLabel.Menu_Add_To_New_Group]: '加入新分组',
	[I18nLabel.Menu_Add_To_Group]: '加入已有分组',
	[I18nLabel.Menu_Remove_From_Group]: '移出分组',
	[I18nLabel.Menu_Ungroup]: '解除分组',
	[I18nLabel.Menu_Expand]: '展开分组',
	[I18nLabel.Menu_Collapse]: '折叠分组',
	[I18nLabel.Rename_Group]: '分组名称',
	[I18nLabel.Group_Color]: '分组颜色',
	[I18nLabel.Group_Pill_Tooltip]: '单击折叠或展开分组；右键管理分组',
	[I18nLabel.Group_Name_Label]: '名称',
	[I18nLabel.Group_Name_Placeholder]: '输入分组名称',
	[I18nLabel.Group_Color_N]: '分组颜色 ?',
	[I18nLabel.Group_Default_Name]: '新分组',
}
export function nativeLabel(key: string): string {
	return labels[key as I18nLabel] ?? I18nLabelDefaults[key] ?? key
}

function isLive(node: Node): boolean {
	return node.getModel().getNodeById(node.getId()) === node
}
function tabContainer(tab: TabNode) {
	const parent = tab.getParent()
	return parent instanceof TabGroupNode ? parent.getParent() : parent
}

/** Only ephemeral menu state lives here; nodes and actions remain native FlexLayout objects. */
export function useNativeMenus(session: WorkspaceSession, root: RefObject<HTMLDivElement | null>) {
	const [menu, setMenu] = useState<OpenMenu | null>(null)
	const close = useCallback(() => setMenu(null), [])
	useEffect(() => {
		if (!menu) return
		const model = menu.node.getModel()
		const changed = () => {
			if (
				!isLive(menu.node) ||
				menu.node.getParent() !== menu.parent ||
				menu.targets?.some((target) => !isLive(target) || tabContainer(target) !== menu.node)
			) {
				close()
				queueMicrotask(() => {
					if (!document.activeElement?.closest('[role="dialog"]')) root.current?.focus()
				})
			}
		}
		model.addChangeListener(changed)
		return () => model.removeChangeListener(changed)
	}, [close, menu, root])
	const openContext = useCallback(
		(
			node: MenuNode,
			event: ReactMouseEvent<HTMLElement>,
			anchor = { x: event.clientX, y: event.clientY },
		) => {
			event.preventDefault()
			event.stopPropagation()
			if (!isLive(node)) return
			const returnFocusTo =
				(event.target as HTMLElement).closest<HTMLElement>(
					'[role="tab"], .flexlayout__group_pill, button',
				) ?? root.current
			if (!returnFocusTo) return
			const model = node.getModel()
			const parent = node.getParent()
			// A retained callback cannot address a replacement node that happens to have the same id.
			const observed = new Map<string, Node>()
			model.visitNodes((candidate) => observed.set(candidate.getId(), candidate))
			const validAction = (action: Action): boolean => {
				if (!isLive(node) || node.getParent() !== parent) return false
				if (action instanceof GroupAction) return action.actions.every(validAction)
				return ['node', 'tabNode', 'tabsetNode', 'fromNode', 'toNode'].every((field) => {
					const id: unknown = action.data[field]
					return (
						typeof id !== 'string' ||
						(model.getNodeById(id) === observed.get(id) && observed.has(id))
					)
				})
			}
			const dispatch = (action: Action) => {
				if (!validAction(action)) {
					close()
					session.report(new Error('菜单目标已改变，请重新打开菜单。'))
					return
				}
				void session.workbench
					.dispatch(action)
					.then((result) => {
						session.check(result)
						if (!isLive(node) && !document.activeElement?.closest('[role="dialog"]'))
							root.current?.focus()
						return result
					})
					.catch((error: unknown) => session.report(error))
			}
			const builder = new ContextMenuBuilder(node, {
				onAction: dispatch,
				closeMenu: close,
				includeDisabled: true,
				getLabel: (action: NodeContextAction, target) =>
					action === 'close'
						? target instanceof TabSetNode
							? '关闭整个标签容器（含折叠分组）'
							: '关闭标签'
						: contextLabel(action, target),
			})
			const addAction = (key: string, label: string, action: Action) =>
				builder.addCustom({
					key,
					label,
					disabled: !session.workbench.canDispatch(action),
					onSelect: () => dispatch(action),
				})
			const pluginPanel = node instanceof TabNode ? readPanelIdentity(node.toJson()) : undefined
			const toolRegion =
				pluginPanel?.region ??
				(node.getId() === 'navigation'
					? 'left'
					: node.getId() === 'plugin-inspector'
						? 'right'
						: undefined)

			if (toolRegion) {
				if (pluginPanel) builder.add('close').addDivider()
				builder.addCustom({
					key: 'toggle-tool',
					label: session.isToolVisible(node.getId()) ? '收起面板' : '展开面板',
					onSelect: () => {
						if (isLive(node))
							void session.toggleTool(node.getId()).catch((error: unknown) => session.report(error))
					},
				})
			} else if (node instanceof TabGroupNode) {
				builder.addStandard()
			} else if (node instanceof TabNode) {
				builder
					.add('pin')
					.add('rename')
					.addDivider()
					.add('addToNewGroup')
					.add('addToGroup')
					.add('removeFromGroup')
				if (session.workbench.getDocument(node.getId())) {
					builder.addDivider().addCustom({
						key: 'duplicate',
						label: '在新标签打开副本',
						onSelect: () => {
							if (isLive(node)) {
								const title = node.getName()
								// The native popup restores its source focus on unmount. Open after that
								// cleanup so a newly selected copy keeps the accepted focus and URL.
								requestAnimationFrame(() => {
									if (!isLive(node)) return
									void session.workbench
										.duplicate(node.getId())
										.then(async (result) => {
											session.check(result)
											if (result.status === 'committed')
												session.check(
													await session.workbench.dispatch(
														Actions.renameTab(result.document.id, title),
													),
												)
											return undefined
										})
										.catch((error: unknown) => session.report(error))
								})
							}
						},
					})
					const container = tabContainer(node)
					if (container instanceof TabSetNode)
						builder.addCustom({
							key: 'duplicate-right',
							label: '在右侧打开副本',
							onSelect: () => {
								if (isLive(node) && isLive(container)) {
									const title = node.getName()
									requestAnimationFrame(() => {
										if (!isLive(node) || !isLive(container)) return
										void session.workbench
											.duplicate(node.getId(), {
												target: container.getId(),
												location: DockLocation.RIGHT,
											})
											.then(async (result) => {
												session.check(result)
												if (result.status === 'committed')
													session.check(
														await session.workbench.dispatch(
															Actions.renameTab(result.document.id, title),
														),
													)
												return undefined
											})
											.catch((error: unknown) => session.report(error))
									})
								}
							},
						})
				}
			} else if (node instanceof TabSetNode) builder.add('maximize')
			else {
				builder.add('borderType')
				const selected = node.getSelectedNode()
				if (selected)
					addAction(
						'hide-border',
						'收起边栏',
						Actions.updateNodeAttributes(node.getId(), { selected: -1 }),
					)
				else {
					const first = node.getTabNodes()[0]
					if (first) addAction('show-border', '显示边栏', Actions.selectTab(first.getId()))
				}
				builder.addCustom({
					key: 'border-size',
					content: (
						<NumberInput
							label="边栏尺寸（像素）"
							size="xs"
							min={Math.max(100, node.getMinSize())}
							max={Math.min(1200, node.getMaxSize())}
							defaultValue={Number(node.getSize())}
							onChange={(size) => {
								if (typeof size === 'number')
									dispatch(Actions.adjustBorderSplit(node.getId(), size))
							}}
						/>
					),
				})
			}
			if (!toolRegion && !(node instanceof BorderNode)) {
				const container =
					node instanceof TabNode
						? tabContainer(node)
						: node instanceof TabGroupNode
							? node.getParent()
							: node
				if (container instanceof TabSetNode && !(node instanceof TabSetNode)) {
					builder.addDivider()
					addAction(
						'split-right',
						node instanceof TabGroupNode ? '将整个分组拆分到右侧' : '将标签拆分到右侧',
						Actions.moveNode(node.getId(), container.getId(), DockLocation.RIGHT, -1),
					)
					addAction(
						'split-bottom',
						node instanceof TabGroupNode ? '将整个分组拆分到下方' : '将标签拆分到下方',
						Actions.moveNode(node.getId(), container.getId(), DockLocation.BOTTOM, -1),
					)
				}
				const destinations: TabSetNode[] = []
				model.visitNodes((candidate) => {
					if (candidate instanceof TabSetNode && candidate !== container && candidate !== node)
						destinations.push(candidate)
				})
				if (destinations.length > 0) builder.addDivider()
				for (const [index, destination] of destinations.entries()) {
					const label = destination.getName() || `标签容器 ${index + 1}`
					addAction(
						`move-${destination.getId()}`,
						`${node instanceof TabGroupNode ? '移动整个分组' : node instanceof TabSetNode ? '合并标签容器' : '移动标签'}到：${label}`,
						Actions.moveNode(node.getId(), destination.getId(), DockLocation.CENTER, -1),
					)
				}
			}
			if (!toolRegion && node instanceof TabGroupNode) {
				builder.addDivider()
				builder.addCustom({
					key: 'close-group',
					label: '关闭分组内全部标签',
					disabled: !session.workbench.canDispatch(
						Actions.group(node.getChildren().map((tab) => Actions.deleteTab(tab.getId()))),
					),
					onSelect: () =>
						dispatch(
							Actions.group(node.getChildren().map((tab) => Actions.deleteTab(tab.getId()))),
						),
				})
			} else if (!toolRegion && node instanceof TabNode)
				builder
					.addDivider()
					.add('closeOthers')
					.add('closeRight')
					.add('closeAll')
					.addDivider()
					.add('close')
			else if (!toolRegion && node instanceof TabSetNode) builder.addDivider().add('close')
			const items = builder.build()
			if (items.length > 0)
				setMenu({
					node,
					parent,
					anchor,
					returnFocusTo,
					items,
					title:
						node instanceof TabGroupNode
							? `管理分组：${node.getName()}`
							: node instanceof TabNode
								? `标签操作：${node.getName()}`
								: node instanceof BorderNode
									? '边栏操作'
									: '标签容器操作',
				})
		},
		[close, root, session],
	)
	const onShowOverflowMenu = useCallback<
		NonNullable<NonNullable<WorkbenchProps['native']>['onShowOverflowMenu']>
	>(
		(node, event, candidates, onSelect) => {
			event.preventDefault()
			event.stopPropagation()
			const target = event.currentTarget
			const items = candidates.map((candidate) => ({
				key: candidate.node.getId(),
				label: candidate.node.getAltName() ?? candidate.node.getName(),
				icon:
					node.getSelectedNode() === candidate.node ? (
						<IconCheck size={15} aria-label="当前标签" />
					) : (
						<IconFile size={15} aria-hidden />
					),
				onSelect: () => {
					if (isLive(node) && isLive(candidate.node) && tabContainer(candidate.node) === node)
						onSelect(candidate)
					else session.report(new Error('该溢出标签已关闭，请重新打开菜单。'))
				},
			}))
			setMenu({
				node,
				parent: node.getParent(),
				targets: candidates.map((candidate) => candidate.node),
				anchor: target,
				returnFocusTo: target,
				items,
				title: '查看溢出标签',
			})
		},
		[session],
	)
	const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
		if (
			event.defaultPrevented ||
			!(event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey))
		)
			return
		const target = event.target as HTMLElement
		if (target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]')) return
		const element = target.closest<HTMLElement>(
			'[role="tab"], .flexlayout__group_pill, .plx-native-container-menu',
		)
		if (!element) return
		const rect = element.getBoundingClientRect()
		element.dispatchEvent(
			new MouseEvent('contextmenu', {
				bubbles: true,
				cancelable: true,
				clientX: rect.left + rect.width / 2,
				clientY: rect.bottom,
			}),
		)
		event.preventDefault()
		event.stopPropagation()
	}, [])
	const native = useMemo<NonNullable<WorkbenchProps['native']>>(
		() => ({
			onContextMenu: openContext,
			onShowOverflowMenu,
			i18nTranslator: nativeLabel,
			keyMap: {
				closeTab: 'Ctrl+Delete',
				renameTab: 'F2',
				focusTabToggle: 'F6',
				focusNextTabset: 'Ctrl+F6',
				focusPreviousTabset: 'Ctrl+Shift+F6',
				closeOverlayBorder: 'Escape',
			},
			icons: {
				close: <IconX size={14} />,
				pin: <IconPin size={14} />,
				more: <IconDots size={16} />,
				maximize: <IconLayoutColumns size={15} />,
			},
			onRenderTabSet: (node, values) => {
				values.buttons.unshift(
					<button
						key="container-menu"
						type="button"
						className="flexlayout__tab_toolbar_button plx-native-container-menu"
						title={node instanceof BorderNode ? '边栏操作' : '标签容器操作'}
						aria-label={node instanceof BorderNode ? '边栏操作' : '标签容器操作'}
						onClick={(event) => {
							const rect = event.currentTarget.getBoundingClientRect()
							openContext(node, event, { x: rect.left, y: rect.bottom })
						}}
					>
						<IconDots size={15} />
					</button>,
				)
			},
		}),
		[onShowOverflowMenu, openContext],
	)
	return {
		native,
		onKeyDown,
		popup: menu && (
			<PopupMenu
				key={menu.node.getId()}
				anchor={menu.anchor}
				container={menu.node.getLayoutRef() ?? root.current ?? undefined}
				returnFocusTo={
					menu.returnFocusTo.isConnected ? menu.returnFocusTo : (root.current ?? undefined)
				}
				items={menu.items}
				title={menu.title}
				onClose={close}
				renderItem={(item, _index, api) => <NativeMenuItem key={item.key} item={item} api={api} />}
			/>
		),
	}
}

function contextLabel(action: NodeContextAction, node: MenuNode): string {
	const key: Partial<Record<NodeContextAction, I18nLabel>> = {
		pin: node instanceof TabNode && node.isPinned() ? I18nLabel.Menu_Unpin : I18nLabel.Menu_Pin,
		rename: I18nLabel.Menu_Rename,
		maximize:
			node instanceof TabSetNode && node.isMaximized()
				? I18nLabel.Menu_Restore
				: I18nLabel.Menu_Maximize,
		borderType:
			node instanceof BorderNode && node.isOverlay()
				? I18nLabel.Menu_Split
				: I18nLabel.Menu_Overlay,
		closeAll: I18nLabel.Menu_Close_All,
		closeRight: I18nLabel.Menu_Close_Right,
		closeOthers: I18nLabel.Menu_Close_Others,
		addToNewGroup: I18nLabel.Menu_Add_To_New_Group,
		addToGroup: I18nLabel.Menu_Add_To_Group,
		removeFromGroup: I18nLabel.Menu_Remove_From_Group,
		ungroup: I18nLabel.Menu_Ungroup,
		toggleOpen:
			node instanceof TabGroupNode && node.isOpened()
				? I18nLabel.Menu_Collapse
				: I18nLabel.Menu_Expand,
	}
	return key[action] ? nativeLabel(key[action]) : action
}

function NativeMenuItem({ item, api }: { item: IPopupMenuItem; api: IPopupMenuItemApi }) {
	return (
		<div
			role="menuitem"
			tabIndex={-1}
			aria-disabled={item.disabled || undefined}
			aria-label={
				item.label ??
				(item.key === 'rename'
					? '分组名称'
					: item.key === 'color'
						? '分组颜色'
						: item.key === 'addToGroup'
							? '加入已有分组'
							: undefined)
			}
			className={`flexlayout__popup_menu_item${item.disabled ? ' flexlayout__popup_menu_item--disabled' : ''}${item.content ? ' plx-native-menu-control' : ''}`}
			data-danger={item.key.startsWith('close') || undefined}
			onClick={
				item.content
					? undefined
					: (event) => {
							event.stopPropagation()
							api.select()
						}
			}
			onFocus={(event) => {
				if (item.content && event.target === event.currentTarget && !item.disabled)
					event.currentTarget.querySelector<HTMLElement>('input, button, select')?.focus()
			}}
			onKeyDown={(event) => {
				// Native custom bodies contain real controls. Their text and activation keys must not
				// become PopupMenu typeahead/selection, or a color click could commit the parent row.
				const target = event.target as HTMLElement
				if (
					target === event.currentTarget ||
					!target.closest('input, button, textarea, select, [contenteditable="true"]')
				)
					return
				if (event.key === 'Escape') {
					event.preventDefault()
					event.stopPropagation()
					api.close()
					return
				}
				if (event.key === 'Tab') return
				if (target.closest('input, textarea, select, [contenteditable="true"]')) {
					event.stopPropagation()
					return
				}
				if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
					const controls = [
						...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input'),
					]
					const index = controls.indexOf(target)
					controls[
						(index + (event.key === 'ArrowRight' ? 1 : -1) + controls.length) % controls.length
					]?.focus()
					event.preventDefault()
					event.stopPropagation()
				} else if (event.key === 'Enter' || event.key === ' ' || event.key.length === 1)
					event.stopPropagation()
			}}
		>
			{item.content && (item.key === 'color' || item.key === 'addToGroup') && (
				<span className="plx-native-menu-control__label">
					{item.key === 'color' ? '颜色' : '加入已有分组'}
				</span>
			)}
			{item.content ?? (
				<>
					{item.icon}
					<span>{item.label}</span>
				</>
			)}
		</div>
	)
}
