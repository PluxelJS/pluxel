import { formatForDisplay } from '@tanstack/react-hotkeys'

export const WORKBENCH_HOTKEYS = {
	showNavigation: 'Mod+B',
	commandPalette: 'Mod+K',
	focusSearch: 'Mod+P',
	closeActiveTab: 'Mod+W',
	prevTab: 'Mod+Shift+[BracketLeft]',
	nextTab: 'Mod+Shift+[BracketRight]',
	maximize: 'Mod+Shift+M',
} as const

export const WORKBENCH_HOTKEY_LABELS = {
	showNavigation: formatForDisplay(WORKBENCH_HOTKEYS.showNavigation),
	commandPalette: formatForDisplay(WORKBENCH_HOTKEYS.commandPalette),
	focusSearch: formatForDisplay(WORKBENCH_HOTKEYS.focusSearch),
	closeActiveTab: formatForDisplay(WORKBENCH_HOTKEYS.closeActiveTab),
	prevTab: formatForDisplay(WORKBENCH_HOTKEYS.prevTab),
	nextTab: formatForDisplay(WORKBENCH_HOTKEYS.nextTab),
	maximize: formatForDisplay(WORKBENCH_HOTKEYS.maximize),
}

export const WORKBENCH_SHORTCUT_ITEMS = [
	[
		`${WORKBENCH_HOTKEY_LABELS.commandPalette} / ${WORKBENCH_HOTKEY_LABELS.focusSearch}`,
		'打开命令面板',
	],
	['↑ / ↓', '在命令面板中选择，Enter 执行'],
	[WORKBENCH_HOTKEY_LABELS.showNavigation, '显示或收起左侧导航'],
	[WORKBENCH_HOTKEY_LABELS.closeActiveTab, '关闭活动文档'],
	[WORKBENCH_HOTKEY_LABELS.prevTab, '上一个文档'],
	[WORKBENCH_HOTKEY_LABELS.nextTab, '下一个文档'],
	[WORKBENCH_HOTKEY_LABELS.maximize, '最大化或还原容器'],
	['Shift + F10 / 菜单键', '打开所聚焦标签、分组或容器的菜单'],
	['F2', '重命名所聚焦标签'],
	['Ctrl + Delete', '关闭所聚焦标签'],
	['F6', '在所选标签和内容间切换焦点'],
	['Ctrl + F6 / Ctrl + Shift + F6', '聚焦下一个或上一个标签容器'],
] as const

export const CATALOG_SHORTCUT_ITEMS = [
	['/', '聚焦搜索'],
	['Ctrl/⌘ + F', '聚焦搜索'],
	['Esc', '关闭帮助 / 清空选择 / 重置筛选'],
	['Alt + 1 / 2 / 3', '切换运行中 / 停止 / 禁用过滤'],
	['↑ / ↓', '切换当前焦点项'],
	['Shift + ↑ / ↓', '连续选择'],
	['Enter', '打开当前焦点插件'],
	['Space', '切换当前项选择状态'],
	['Ctrl/⌘ + A', '全选当前可见插件'],
	['M / U', '移动到已注册分类、移回未分组'],
] as const

export const PLUGIN_DETAIL_HOTKEYS = {
	saveCurrentConfig: 'Mod+S',
	saveAllConfig: 'Mod+Shift+S',
	restartPlugin: 'Mod+Alt+R',
} as const

export const PLUGIN_DETAIL_HOTKEY_LABELS = {
	saveCurrentConfig: formatForDisplay(PLUGIN_DETAIL_HOTKEYS.saveCurrentConfig),
	saveAllConfig: formatForDisplay(PLUGIN_DETAIL_HOTKEYS.saveAllConfig),
	restartPlugin: formatForDisplay(PLUGIN_DETAIL_HOTKEYS.restartPlugin),
}

export const PLUGIN_DETAIL_SHORTCUT_ITEMS = [
	['Ctrl/⌘ + S', '保存当前配置页'],
	['Ctrl/⌘ + Shift + S', '保存全部修改'],
	['Ctrl/⌘ + Alt + R', '重启当前插件'],
] as const
