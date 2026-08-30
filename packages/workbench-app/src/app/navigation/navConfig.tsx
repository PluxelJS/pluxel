import { isValidElement, type ReactNode } from 'react'
import type { WorkbenchIcon } from '@pluxel/runtime/workbench'
import {
	IconApi,
	IconBrandDiscord,
	IconBrandTelegram,
	IconBuilding,
	IconChartBar,
	IconChartDots3,
	IconCloudUpload,
	IconHistory,
	IconHome2,
	IconMessageChatbot,
	IconPlugConnected,
	IconPuzzle,
	IconReceipt,
	IconRobot,
	IconSearch,
	IconSettings,
	IconShieldLock,
	IconTestPipe,
	IconTextRecognition,
	IconTypography,
	IconUsers,
	type Icon,
} from '@tabler/icons-react'
import { BUILTIN_WORKBENCH_ROUTES, type BuiltinWorkbenchIcon } from '../workbench/location'

export interface NavItem {
	label: string
	href: string
	icon?: ReactNode
	exact?: boolean
	group?: NavGroup
}

export interface NavGroup {
	id: string
	label: string
	icon?: ReactNode
}

export interface NavSection extends NavItem {
	children?: NavItem[]
}

const builtinWorkbenchIconMap = {
	home: IconHome2,
	logs: IconHistory,
	security: IconShieldLock,
	'agent-tools': IconRobot,
	plugins: IconPuzzle,
	'plugin-graph': IconChartDots3,
} satisfies Record<BuiltinWorkbenchIcon, Icon>

export const baseNavItems: NavItem[] = BUILTIN_WORKBENCH_ROUTES.filter(
	(route) => route.navigation,
).map((route) => {
	const Component = builtinWorkbenchIconMap[route.icon]
	return {
		label: route.title,
		href: route.path,
		exact: route.path === '/',
		icon: <Component size={18} stroke={1.7} />,
	}
})

const workbenchIconMap = {
	api: IconApi,
	'brand-discord': IconBrandDiscord,
	'brand-telegram': IconBrandTelegram,
	building: IconBuilding,
	'chart-bar': IconChartBar,
	'cloud-upload': IconCloudUpload,
	history: IconHistory,
	'message-chatbot': IconMessageChatbot,
	'plug-connected': IconPlugConnected,
	receipt: IconReceipt,
	search: IconSearch,
	settings: IconSettings,
	'shield-lock': IconShieldLock,
	'test-pipe': IconTestPipe,
	'text-recognition': IconTextRecognition,
	typography: IconTypography,
	users: IconUsers,
} satisfies Record<WorkbenchIcon, Icon>

// Workbench layout records carry serializable icon tokens. The host owns their visual mapping.
export function resolveNavIcon(icon: unknown): ReactNode | undefined {
	if (!icon) return undefined
	if (isValidElement(icon)) return icon
	if (typeof icon === 'string') {
		const Component = icon in workbenchIconMap ? workbenchIconMap[icon as WorkbenchIcon] : undefined
		return Component ? <Component size={18} stroke={1.7} /> : undefined
	}
	return undefined
}

export interface WorkbenchNavMeta {
	id: string
	label?: string
	href?: string
	icon?: unknown
	exact?: boolean
	group?: {
		id: string
		label: string
		icon?: unknown
	}
}

export function buildWorkbenchNavItems(entries: WorkbenchNavMeta[]): NavItem[] {
	return entries.map((entry) => {
		const label = typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : entry.id
		const href = typeof entry.href === 'string' && entry.href.length > 0 ? entry.href : '#'
		return {
			label,
			href,
			icon: resolveNavIcon(entry.icon),
			exact: entry.exact === true,
			group: entry.group
				? {
						id: entry.group.id,
						label: entry.group.label,
						icon: resolveNavIcon(entry.group.icon),
					}
				: undefined,
		}
	})
}

export function groupNavItems(items: readonly NavItem[]): NavSection[] {
	const output: NavSection[] = []
	const groups = new Map<string, { index: number; group: NavGroup; children: NavItem[] }>()
	for (const item of items) {
		if (!item.group) {
			output.push(item)
			continue
		}
		const existing = groups.get(item.group.id)
		if (existing) {
			existing.children.push(item)
			continue
		}
		const entry = { index: output.length, group: item.group, children: [item] }
		groups.set(item.group.id, entry)
		output.push({ label: item.group.label, href: item.href, icon: item.group.icon })
	}
	for (const { index, group, children } of groups.values()) {
		output[index] = {
			label: group.label,
			href: children[0]?.href ?? '#',
			icon: group.icon,
			children: children.map(({ group: _group, ...child }) => child),
		}
	}
	return output
}
