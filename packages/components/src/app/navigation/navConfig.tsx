import { isValidElement, type ReactNode } from 'react'
import {
	IconActivity,
	IconApi,
	IconBrandDiscord,
	IconBrandTelegram,
	IconChartBar,
	IconCloudUpload,
	IconForms,
	IconHistory,
	IconHome2,
	IconKey,
	IconMessageChatbot,
	IconPackages,
	IconPlug,
	IconPlugConnected,
	IconPuzzle,
	IconReceipt,
	IconSearch,
	IconServerCog,
	IconSettings,
	IconShieldLock,
	IconTestPipe,
	IconTextRecognition,
	IconTypography,
	IconUsers,
	type Icon,
} from '@tabler/icons-react'

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
	{ label: '安全', href: '/security', icon: <IconShieldLock size={18} stroke={1.7} /> },
	{ label: '包管理', href: '/packages', icon: <IconPackages size={18} stroke={1.7} /> },
	{ label: '插件', href: '/plugins', icon: <IconPuzzle size={18} stroke={1.7} /> },
]

const extensionIconMap: Readonly<Record<string, Icon>> = {
	activity: IconActivity,
	api: IconApi,
	'brand-discord': IconBrandDiscord,
	'brand-telegram': IconBrandTelegram,
	'chart-bar': IconChartBar,
	'cloud-upload': IconCloudUpload,
	form: IconForms,
	history: IconHistory,
	key: IconKey,
	'message-chatbot': IconMessageChatbot,
	plug: IconPlug,
	'plug-connected': IconPlugConnected,
	receipt: IconReceipt,
	search: IconSearch,
	'server-cog': IconServerCog,
	settings: IconSettings,
	'shield-lock': IconShieldLock,
	'test-pipe': IconTestPipe,
	'text-recognition': IconTextRecognition,
	typography: IconTypography,
	users: IconUsers,
}

// Workbench contracts carry serializable icon tokens. The host owns their visual mapping.
export function resolveNavIcon(icon: unknown): ReactNode | undefined {
	if (!icon) return undefined
	if (isValidElement(icon)) return icon
	if (typeof icon === 'string') {
		const Component = extensionIconMap[icon]
		return Component ? <Component size={18} stroke={1.7} /> : undefined
	}
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
