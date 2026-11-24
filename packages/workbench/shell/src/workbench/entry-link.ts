import { formatPluginNodeReference, pluginNodeAddressEqual } from '@pluxel/core'
import type { WorkbenchIcon } from '@pluxel/workbench'
import type { WorkbenchEntryLink } from '@pluxel/workbench/client'
import type { WorkbenchTargetSnapshot } from './client-snapshot'
import { buildPluginDetailHref, buildWorkbenchHref } from './paths'
import { matchWorkbenchRoute } from '../../../src/workbench/routes'

export function sidebarShortcutId(link: WorkbenchEntryLink): string {
	return JSON.stringify([formatPluginNodeReference(link.target), link.entryKey])
}

type ResolvedEntryLink = Readonly<{ label: string; icon?: WorkbenchIcon }> &
	(
		| Readonly<{ href: string; unavailable?: never }>
		| Readonly<{ unavailable: string; href?: never }>
	)

/** Resolve a validated link against the current global layout before opening any document. */
export function resolveWorkbenchEntryLink(
	link: WorkbenchEntryLink,
	snapshot: WorkbenchTargetSnapshot,
	address: 'preferred' | 'canonical' = 'preferred',
): ResolvedEntryLink {
	if (snapshot.state !== 'ready') {
		return { label: link.entryKey, unavailable: snapshot.error?.message ?? '正在读取工作台入口' }
	}
	const entry = snapshot.layout?.entries.find(
		(candidate) =>
			candidate.descriptor.key === link.entryKey &&
			pluginNodeAddressEqual(candidate.target.node, link.target),
	)
	if (!entry || entry.placement.kind === 'panel')
		return { label: link.entryKey, unavailable: '此节点未发布该标签页或路由' }
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
		if (link.location !== undefined) return { ...display, unavailable: '标签页不接受页面路径' }
		return {
			...display,
			href: `${buildPluginDetailHref(entry.target.node)}?entry=${encodeURIComponent(link.entryKey)}`,
		}
	}
	const url = new URL(link.location ?? placement.path, 'https://workbench.invalid')
	// Route screens use the most specific match within the owner, including static overrides.
	const route = snapshot.directory.routes.find(
		(candidate) =>
			pluginNodeAddressEqual(candidate.entry.target.node, link.target) &&
			matchWorkbenchRoute(candidate.compiled, url.pathname) !== null,
	)
	if (route?.entry !== entry) return { ...display, unavailable: '页面路径与指定入口不匹配' }
	const path =
		address === 'canonical' || route.conflict
			? buildWorkbenchHref(link.target, url.pathname, placement.frame)
			: url.pathname
	return { ...display, href: path + url.search + url.hash }
}
