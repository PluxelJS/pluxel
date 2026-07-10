export const WORKBENCH_HOTKEYS = {
	togglePluginRail: 'Mod+B',
	focusSearch: 'Mod+K',
	closeActiveTab: 'Mod+W',
	prevTab: 'Mod+Shift+BracketLeft',
	nextTab: 'Mod+Shift+BracketRight',
} as const

export const WORKBENCH_HOTKEY_LABELS = {
	togglePluginRail: '⌘B',
	focusSearch: '⌘K',
	closeActiveTab: '⌘W',
	prevTab: '⌘⇧[',
	nextTab: '⌘⇧]',
} as const

export const WORKBENCH_SHORTCUT_ITEMS = [
	['Ctrl/⌘ + K', '打开插件搜索'],
	['Ctrl/⌘ + B', '显示或隐藏插件列表'],
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
	['Ctrl/⌘ + Enter', '在独立工作标签打开当前焦点插件'],
	['Space', '切换当前项选择状态'],
	['Ctrl/⌘ + A', '全选当前可见插件'],
	['G / M / U', '创建分组、移动到分组、移回未分组'],
] as const

export const PLUGIN_DETAIL_HOTKEYS = {
	saveCurrentConfig: 'mod+S',
	saveAllConfig: 'mod+Shift+S',
	restartPlugin: 'mod+Alt+R',
} as const

export const PLUGIN_DETAIL_HOTKEY_LABELS = {
	saveCurrentConfig: '⌘S',
	saveAllConfig: '⌘⇧S',
	restartPlugin: '⌘⌥R',
} as const

export const PLUGIN_DETAIL_SHORTCUT_ITEMS = [
	['Ctrl/⌘ + S', '保存当前配置页'],
	['Ctrl/⌘ + Shift + S', '保存当前插件全部脏配置'],
	['Ctrl/⌘ + Alt + R', '重启当前插件'],
] as const
