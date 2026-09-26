import { formatForDisplay, type Hotkey } from '@tanstack/react-hotkeys'

export const WORKBENCH_HOTKEYS = {
	togglePluginRail: 'Mod+B',
	toggleDock: 'Mod+J',
	toggleRightPane: 'Mod+Alt+B',
	focusSearch: 'Mod+P',
	closeActiveTab: 'Mod+W',
	prevTab: 'Mod+Shift+BracketLeft',
	nextTab: 'Mod+Shift+BracketRight',
} as const

const TOGGLE_FOCUS_MODE_SEQUENCE: [Hotkey, Hotkey] = ['Mod+K', 'Z']

export const WORKBENCH_HOTKEY_SEQUENCES = {
	toggleFocusMode: TOGGLE_FOCUS_MODE_SEQUENCE,
} as const

export const WORKBENCH_HOTKEY_LABELS = {
	togglePluginRail: formatForDisplay(WORKBENCH_HOTKEYS.togglePluginRail),
	toggleDock: formatForDisplay(WORKBENCH_HOTKEYS.toggleDock),
	toggleRightPane: formatForDisplay(WORKBENCH_HOTKEYS.toggleRightPane),
	toggleFocusMode: WORKBENCH_HOTKEY_SEQUENCES.toggleFocusMode
		.map((hotkey) => formatForDisplay(hotkey))
		.join(' '),
	focusSearch: formatForDisplay(WORKBENCH_HOTKEYS.focusSearch),
	closeActiveTab: formatForDisplay(WORKBENCH_HOTKEYS.closeActiveTab),
	prevTab: formatForDisplay(WORKBENCH_HOTKEYS.prevTab),
	nextTab: formatForDisplay(WORKBENCH_HOTKEYS.nextTab),
}

export const WORKBENCH_SHORTCUT_ITEMS = [
	['Ctrl/⌘ + P', '打开插件搜索'],
	['Ctrl/⌘ + B', '显示或隐藏插件列表'],
	['Ctrl/⌘ + Alt + B', '显示或隐藏辅助侧栏'],
	['Ctrl/⌘ + J', '显示或隐藏底部面板'],
	['Ctrl/⌘ + K → Z', '进入或退出聚焦工作区'],
	['Ctrl/⌘ + W', '关闭当前工作标签'],
	['Ctrl/⌘ + Shift + [', '切到上一个工作标签'],
	['Ctrl/⌘ + Shift + ]', '切到下一个工作标签'],
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
