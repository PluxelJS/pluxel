import { readPanelIdentity } from './panelTabs'
import { NumberInput } from '@mantine/core'
import { IconDots, IconLayoutColumns, IconPin, IconX } from '@tabler/icons-react'
import {
	Actions,
	BorderNode,
	ContextMenuBuilder,
	DockLocation,
	I18nLabel,
	I18nLabelDefaults,
	TabGroupNode,
	TabNode,
	TabSetNode,
	type Action,
	type PopupMenuEntry,
} from 'flexlayout-react'
import { useMemo } from 'react'
import { beside, type WorkbenchProps } from '@worksplit/react'
import type { WorkspaceSession } from './session'

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

/** Worksplit owns menu lifetime, guarded actions and focus handoff; Shell supplies language and business tools. */
export function useNativeMenus(session: WorkspaceSession) {
	return useMemo(
		() => ({
			native: {
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
			} satisfies NonNullable<WorkbenchProps['native']>,
			menus: {
				labels: {
					keepOpen: '保留预览标签',
					duplicate: '在新标签打开副本',
					splitRight: '将标签拆分到右侧',
					splitDown: '将标签拆分到下方',
					closeGroup: '关闭整个标签容器（含折叠分组）',
				},
				transform: ({ node, items, instance }) => {
					const dispatch = (action: Action) => {
						void instance.dispatch(action).then((result) => session.check(result))
					}
					const actionItem = (key: string, label: string, action: Action): PopupMenuEntry => ({
						key,
						label,
						disabled: !instance.canDispatch(action),
						onSelect: () => dispatch(action),
					})
					if (node instanceof TabNode) {
						const panel = readPanelIdentity(node.toJson())
						if (panel || node.getId() === 'navigation' || node.getId() === 'plugin-inspector')
							return [
								...items.filter((item) => item.type !== 'divider' && item.key === 'close'),
								{
									key: 'toggle-tool',
									label: session.isToolVisible(node.getId()) ? '收起面板' : '展开面板',
									onSelect: () => {
										void session
											.toggleTool(node.getId())
											.catch((error: unknown) => session.report(error))
									},
								},
							]
						items.push(
							...new ContextMenuBuilder(node, { includeDisabled: true, onAction: dispatch })
								.add('closeAll')
								.build(),
						)
						if (instance.getDocument(node.getId()))
							items.push({
								key: 'duplicate-right',
								label: '在右侧打开副本',
								onSelect: () => {
									void instance
										.duplicate(node.getId(), {
											destination: beside({ direction: DockLocation.RIGHT }),
										})
										.then((result) => session.check(result))
										.catch((error: unknown) => session.report(error))
								},
							})
					}
					if (node instanceof BorderNode) {
						const first = node.getTabNodes()[0]
						if (first)
							items.push(
								actionItem(
									'toggle-border',
									node.getSelected() >= 0 ? '收起边栏' : '显示边栏',
									Actions.updateNodeAttributes(node.getId(), {
										selected: node.getSelected() >= 0 ? -1 : 0,
									}),
								),
							)
						items.push({
							key: 'border-size',
							content: (
								<NumberInput
									label="边栏尺寸（像素）"
									size="xs"
									min={Math.max(100, node.getMinSize())}
									max={Math.min(1200, node.getMaxSize())}
									defaultValue={node.getSize()}
									onChange={(size) => {
										if (typeof size === 'number')
											dispatch(Actions.adjustBorderSplit(node.getId(), size))
									}}
								/>
							),
						})
						return items
					}
					const parent = node.getParent()
					const container = parent instanceof TabGroupNode ? parent.getParent() : parent
					if (node instanceof TabGroupNode && container instanceof TabSetNode)
						for (const [key, direction, label] of [
							['splitRight', DockLocation.RIGHT, '将整个分组拆分到右侧'],
							['splitDown', DockLocation.BOTTOM, '将整个分组拆分到下方'],
						] as const)
							items.push(
								actionItem(
									key,
									label,
									Actions.moveNode(node.getId(), container.getId(), direction, -1),
								),
							)
					for (const [index, destination] of instance
						.getContainers()
						.filter(
							(candidate) =>
								candidate.kind === 'tabset' &&
								candidate.node !== node &&
								candidate.node !== container,
						)
						.entries()) {
						const action = Actions.moveNode(node.getId(), destination.id, DockLocation.CENTER, -1)
						items.push({
							key: `move-${destination.id}`,
							label: `移动到：${(destination.node instanceof TabSetNode ? destination.node.getName() : undefined) || `标签容器 ${index + 1}`}`,
							disabled: !instance.canDispatch(action),
							onSelect: () => {
								if (instance.model.getNodeById(destination.id) === destination.node)
									dispatch(action)
							},
						})
					}
					return items
				},
			} satisfies WorkbenchProps['menus'],
		}),
		[session],
	)
}
