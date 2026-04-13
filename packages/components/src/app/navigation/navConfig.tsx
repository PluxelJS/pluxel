import { isValidElement, type ReactNode } from 'react'
import { IconHistory, IconHome2, IconPackages, IconPuzzle, IconTool } from '@tabler/icons-react'

export interface NavItem {
	label: string
	href: string
	icon?: ReactNode
	rightSection?: ReactNode
	exact?: boolean
	disabled?: boolean
}

export const baseNavItems: NavItem[] = [
	{ label: '首页', href: '/', exact: true, icon: <IconHome2 size={18} stroke={1.7} /> },
	{ label: '日志', href: '/logs', icon: <IconHistory size={18} stroke={1.7} /> },
	{ label: '包管理', href: '/packages', icon: <IconPackages size={18} stroke={1.7} /> },
	{ label: 'Ops', href: '/ops', icon: <IconTool size={18} stroke={1.7} /> },
	{ label: '插件', href: '/plugins', icon: <IconPuzzle size={18} stroke={1.7} /> },
]

// Shell 不再提供图标库，插件若需图标必须传入完整 ReactNode
export function resolveNavIcon(icon: unknown): ReactNode | undefined {
	if (!icon) return undefined
	if (isValidElement(icon)) return icon
	return undefined
}

export interface ExtensionNavMeta {
	id: string
	label?: string
	href?: string
	icon?: unknown
	rightSection?: unknown
	exact?: boolean
}

export function buildExtensionNavItems(entries: ExtensionNavMeta[]): NavItem[] {
	return entries.map((entry) => {
		const label = typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : entry.id
		const href = typeof entry.href === 'string' && entry.href.length > 0 ? entry.href : '#'
		const rightSection = isValidElement(entry.rightSection)
			? (entry.rightSection as ReactNode)
			: undefined
		return {
			label,
			href,
			icon: resolveNavIcon(entry.icon),
			rightSection,
			exact: entry.exact === true,
		}
	})
}
