import type { WorkbenchTab, WorkbenchUiState } from './state'

function decodeSegment(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

export function deriveTabFromPath(pathname: string): WorkbenchTab {
	if (!pathname || pathname === '/') {
		return { id: 'home', path: '/', title: '首页', meta: 'Workbench' }
	}
	if (pathname === '/logs') {
		return { id: 'logs', path: pathname, title: '日志', meta: 'Runtime' }
	}
	if (pathname === '/packages') {
		return { id: 'packages', path: pathname, title: '包管理', meta: 'Registry' }
	}
	if (pathname === '/plugins') {
		return { id: 'plugins', path: pathname, title: '插件', meta: 'Overview' }
	}
	const pluginMatch = pathname.match(/^\/plugins\/([^/]+)(?:\/(.*))?$/)
	if (pluginMatch) {
		const pluginName = decodeSegment(pluginMatch[1] ?? '')
		const tail = pluginMatch[2] ?? ''
		if (!tail) {
			return {
				id: `plugin:${pluginName}:overview`,
				path: pathname,
				title: pluginName,
				meta: '概览',
			}
		}
		if (tail === 'config') {
			return { id: `plugin:${pluginName}:config`, path: pathname, title: pluginName, meta: '配置' }
		}
		return {
			id: `plugin:${pluginName}:page:${tail}`,
			path: pathname,
			title: pluginName,
			meta: tail.replaceAll('/', ' / '),
		}
	}
	const extMatch = pathname.match(/^\/ext\/([^/]+)\/(.*)$/)
	if (extMatch) {
		return {
			id: `ext:${decodeSegment(extMatch[1] ?? '')}:${extMatch[2] ?? ''}`,
			path: pathname,
			title: decodeSegment(extMatch[1] ?? '扩展'),
			meta: '扩展',
		}
	}
	const section = pathname.split('/').filter(Boolean)[0] ?? '页面'
	return {
		id: `route:${pathname}`,
		path: pathname,
		title: section,
		meta: pathname,
	}
}

function upsertTab(tabs: WorkbenchTab[], nextTab: WorkbenchTab) {
	const existingIndex = tabs.findIndex((tab) => tab.id === nextTab.id)
	if (existingIndex === -1) return [...tabs, nextTab]
	const clone = [...tabs]
	clone[existingIndex] = nextTab
	return clone
}

function replaceActiveTab(tabs: WorkbenchTab[], activeTabId: string | null, nextTab: WorkbenchTab) {
	if (!activeTabId) return [nextTab]
	const seen = new Set<string>()
	const nextTabs = tabs
		.map((tab) => (tab.id === activeTabId ? nextTab : tab))
		.filter((tab) => {
			if (seen.has(tab.id)) return false
			seen.add(tab.id)
			return true
		})
	return nextTabs.length > 0 ? nextTabs : [nextTab]
}

function removeTabById(tabs: WorkbenchTab[], tabId: string | null) {
	if (!tabId) return tabs
	return tabs.filter((tab) => tab.id !== tabId)
}

export function syncWorkbenchTabs(
	prev: WorkbenchUiState,
	nextTab: WorkbenchTab,
	mode: 'replace-active' | 'open-tab',
) {
	const tabs = prev.tabs.length > 0 ? prev.tabs : [nextTab]
	const activeTabId = prev.activeTabId ?? tabs[0]?.id ?? null
	const targetExists = tabs.some((tab) => tab.id === nextTab.id)

	if (activeTabId === nextTab.id) {
		return {
			...prev,
			tabs: upsertTab(tabs, nextTab),
			activeTabId: nextTab.id,
		}
	}

	if (mode === 'open-tab') {
		return {
			...prev,
			tabs: upsertTab(tabs, nextTab),
			activeTabId: nextTab.id,
		}
	}

	if (targetExists) {
		return {
			...prev,
			tabs: upsertTab(removeTabById(tabs, activeTabId), nextTab),
			activeTabId: nextTab.id,
		}
	}

	return {
		...prev,
		tabs: replaceActiveTab(tabs, activeTabId, nextTab),
		activeTabId: nextTab.id,
	}
}
