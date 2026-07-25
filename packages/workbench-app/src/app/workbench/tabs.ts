import type { WorkbenchTab, WorkbenchUiState } from './state'
import { parseWorkbenchHref } from '../../workbench/paths'

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
	if (pathname === '/security') {
		return { id: 'security', path: pathname, title: '安全', meta: 'Host' }
	}
	if (pathname === '/security/audit') {
		return { id: 'security:audit', path: pathname, title: '审计事件', meta: 'Security' }
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
		return {
			id: `plugin:${pluginName}`,
			path: pathname,
			title: pluginName,
			meta: tail ? (tail === 'config' ? '配置' : tail.replaceAll('/', ' / ')) : '概览',
		}
	}
	const workbenchRoute = parseWorkbenchHref(pathname)
	if (workbenchRoute?.frame === 'shell') {
		return {
			id: `workbench:${workbenchRoute.pluginName}:${workbenchRoute.path}`,
			path: pathname,
			title: workbenchRoute.pluginName,
			meta: 'Workbench',
		}
	}
	const section = pathname.split('/').find(Boolean) ?? '页面'
	return {
		id: `route:${pathname}`,
		path: pathname,
		title: section,
		meta: pathname,
	}
}

function sameWorkbenchTab(left: WorkbenchTab, right: WorkbenchTab) {
	return (
		left.id === right.id &&
		left.path === right.path &&
		left.title === right.title &&
		left.meta === right.meta &&
		left.kind === right.kind
	)
}

function sameWorkbenchTabs(left: WorkbenchTab[], right: WorkbenchTab[]) {
	return (
		left.length === right.length && left.every((tab, index) => sameWorkbenchTab(tab, right[index]))
	)
}

function preserveEqualTabs(previous: WorkbenchTab[], next: WorkbenchTab[]) {
	return sameWorkbenchTabs(previous, next) ? previous : next
}

function upsertTab(tabs: WorkbenchTab[], nextTab: WorkbenchTab) {
	const existingIndex = tabs.findIndex((tab) => tab.id === nextTab.id)
	if (existingIndex === -1) return [...tabs, nextTab]
	if (sameWorkbenchTab(tabs[existingIndex], nextTab)) return tabs
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
	return preserveEqualTabs(tabs, nextTabs.length > 0 ? nextTabs : [nextTab])
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
		const nextTabs = upsertTab(tabs, nextTab)
		if (prev.activeTabId === nextTab.id && nextTabs === prev.tabs) return prev
		return {
			...prev,
			tabs: nextTabs,
			activeTabId: nextTab.id,
		}
	}

	if (mode === 'open-tab') {
		const nextTabs = upsertTab(tabs, nextTab)
		return {
			...prev,
			tabs: nextTabs,
			activeTabId: nextTab.id,
		}
	}

	if (targetExists) {
		const nextTabs = upsertTab(removeTabById(tabs, activeTabId), nextTab)
		return {
			...prev,
			tabs: nextTabs,
			activeTabId: nextTab.id,
		}
	}

	return {
		...prev,
		tabs: replaceActiveTab(tabs, activeTabId, nextTab),
		activeTabId: nextTab.id,
	}
}
