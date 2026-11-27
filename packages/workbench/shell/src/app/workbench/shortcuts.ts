import { baseLocale, m, type Locale } from '#i18n'
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

export function workbenchShortcutItems(locale: Locale = baseLocale) {
	const options = { locale }
	return [
		[
			`${WORKBENCH_HOTKEY_LABELS.commandPalette} / ${WORKBENCH_HOTKEY_LABELS.focusSearch}`,
			m['keyboard.palette']({}, options),
		],
		['↑ / ↓', m['keyboard.result']({}, options)],
		[WORKBENCH_HOTKEY_LABELS.showNavigation, m['keyboard.sidebar']({}, options)],
		[WORKBENCH_HOTKEY_LABELS.closeActiveTab, m['keyboard.closeActive']({}, options)],
		[WORKBENCH_HOTKEY_LABELS.prevTab, m['keyboard.previous']({}, options)],
		[WORKBENCH_HOTKEY_LABELS.nextTab, m['keyboard.next']({}, options)],
		[WORKBENCH_HOTKEY_LABELS.maximize, m['keyboard.maximize']({}, options)],
		[`Shift + F10 / ${m['keyboard.menuKey']({}, options)}`, m['keyboard.menu']({}, options)],
		['F2', m['keyboard.rename']({}, options)],
		['Ctrl + Delete', m['keyboard.closeFocused']({}, options)],
		['F6', m['keyboard.focusContent']({}, options)],
		['Ctrl + F6 / Ctrl + Shift + F6', m['keyboard.focusGroup']({}, options)],
	] as const
}

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
	['Ctrl/⌘ + Shift + S', '保存当前插件全部脏配置'],
	['Ctrl/⌘ + Alt + R', '重启当前插件'],
] as const
