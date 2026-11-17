import { pluginNodeAddressEqual } from '@pluxel/core'
import type { WorkbenchIcon } from '@pluxel/workbench'
import type { WorkbenchLayout, WorkbenchShortcut } from '@pluxel/workbench/client'
import { buildPluginDetailHref } from '../../workbench/paths'
import {
	getWorkbenchDirectoryHref,
	type WorkbenchRouteDirectory,
} from '../../workbench/route-directory'
import { matchWorkbenchRoute } from '../../workbench/routes'

/** Resolve the saved identity against today's publication; never substitute another owner. */
export function resolveSidebarShortcut(
	shortcut: WorkbenchShortcut,
	layout: WorkbenchLayout | null | undefined,
	directory: WorkbenchRouteDirectory,
): Readonly<{ label: string; icon?: WorkbenchIcon; href?: string; unavailable?: string }> {
	const entry = layout?.entries.find(
		(candidate) =>
			candidate.descriptor.key === shortcut.entryKey &&
			pluginNodeAddressEqual(candidate.target.node, shortcut.target),
	)
	if (!entry || entry.placement.kind === 'panel')
		return { label: shortcut.entryKey, unavailable: '入口未发布或插件已停止' }
	const placement = entry.placement
	const label =
		placement.kind === 'tab'
			? (placement.label ?? entry.descriptor.key)
			: (placement.navigation?.label ?? placement.title)
	const display = { label, ...(placement.icon ? { icon: placement.icon } : {}) }
	if ('federatedViewUnavailable' in entry && entry.federatedViewUnavailable) {
		return {
			...display,
			unavailable:
				entry.federatedViewUnavailable.reason === 'building' ? '界面正在构建' : '界面构建失败',
		}
	}
	if (placement.kind === 'tab') {
		return {
			...display,
			href: `${buildPluginDetailHref(entry.target.node)}?entry=${encodeURIComponent(entry.descriptor.key)}`,
		}
	}
	const route = directory.routes.find((candidate) => candidate.entry === entry)
	if (!route) return { ...display, unavailable: '入口路由不可用' }
	const location = shortcut.location ?? placement.path
	const url = new URL(location, 'https://workbench.invalid')
	const params = matchWorkbenchRoute(route.compiled, url.pathname)
	if (!params || Object.entries(params).some(([name, value]) => value === `:${name}`)) {
		return { ...display, unavailable: '页面路径已改变，请在应用中重新固定' }
	}
	return {
		...display,
		href:
			getWorkbenchDirectoryHref(directory, entry.target.node, url.pathname, placement.frame) +
			url.search +
			url.hash,
	}
}
