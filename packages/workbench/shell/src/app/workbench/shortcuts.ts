import { formatForDisplay } from '@tanstack/react-hotkeys'

export const WORKBENCH_HOTKEYS = {
	showNavigation: 'Mod+B',
	focusSearch: 'Mod+P',
	closeActiveTab: 'Mod+W',
	prevTab: 'Mod+Shift+[BracketLeft]',
	nextTab: 'Mod+Shift+[BracketRight]',
	maximize: 'Mod+Shift+M',
} as const

export const WORKBENCH_HOTKEY_LABELS = {
	showNavigation: formatForDisplay(WORKBENCH_HOTKEYS.showNavigation),
	focusSearch: formatForDisplay(WORKBENCH_HOTKEYS.focusSearch),
	closeActiveTab: formatForDisplay(WORKBENCH_HOTKEYS.closeActiveTab),
	prevTab: formatForDisplay(WORKBENCH_HOTKEYS.prevTab),
	nextTab: formatForDisplay(WORKBENCH_HOTKEYS.nextTab),
	maximize: formatForDisplay(WORKBENCH_HOTKEYS.maximize),
}

export const WORKBENCH_SHORTCUT_ITEMS = [
	[WORKBENCH_HOTKEY_LABELS.focusSearch, '查找所有页面与插件入口'],
	[WORKBENCH_HOTKEY_LABELS.showNavigation, '显示或重新打开入口导航'],
	[WORKBENCH_HOTKEY_LABELS.closeActiveTab, '关闭活动文档（遵守固定与未保存保护）'],
	[WORKBENCH_HOTKEY_LABELS.prevTab, '按原生布局顺序激活上一个文档'],
	[WORKBENCH_HOTKEY_LABELS.nextTab, '按原生布局顺序激活下一个文档'],
	[WORKBENCH_HOTKEY_LABELS.maximize, '最大化或还原活动文档所在容器'],
	['Shift + F10 / 菜单键', '打开所聚焦标签、分组或容器的菜单'],
	['F2', '重命名所聚焦标签'],
	['Ctrl + Delete', '关闭所聚焦标签'],
	['F6', '在所选标签和内容间切换焦点'],
	['Ctrl + F6 / Ctrl + Shift + F6', '聚焦下一个或上一个标签容器'],
] as const

export const CATALOG_SHORTCUT_ITEMS = [
	['/', '聚焦搜索'],
	['Ctrl/⌘ + F', '聚焦搜索'],
	['Esc', '按顺序关闭帮助、清空选择、重置搜索与筛选'],
	['Alt + 1 / 2 / 3', '切换运行中 / 停止 / 禁用过滤'],
	['↑ / ↓', '切换当前焦点项'],
	['Shift + ↑ / ↓', '连续选择'],
	['Enter', '打开当前焦点插件'],
	['Space', '切换当前项选择状态'],
	['Ctrl/⌘ + A', '全选当前可见插件'],
	['M / U', '移动到已注册分类、移回未分组'],
] as const

export const PLUGIN_DETAIL_HOTKEYS = {
	saveCurrentConfig: 'mod+S',
	saveAllConfig: 'mod+Shift+S',
	restartPlugin: 'mod+Alt+R',
} as const

export const PLUGIN_DETAIL_HOTKEY_LABELS = {
	saveCurrentConfig: formatForDisplay(PLUGIN_DETAIL_HOTKEYS.saveCurrentConfig),
	saveAllConfig: formatForDisplay(PLUGIN_DETAIL_HOTKEYS.saveAllConfig),
	restartPlugin: formatForDisplay(PLUGIN_DETAIL_HOTKEYS.restartPlugin),
}

export const PLUGIN_DETAIL_SHORTCUT_ITEMS = [
	['Ctrl/⌘ + S', '保存当前配置页'],
	['Ctrl/⌘ + Shift + S', '保存当前插件全部脏配置'],
	['Ctrl/⌘ + Alt + R', '重启当前插件'],
] as const
