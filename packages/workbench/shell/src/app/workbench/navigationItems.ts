import {
	IconHome2,
	IconApps,
	IconPuzzle,
	IconTerminal2,
	IconShieldLock,
	IconHistory,
	IconTopologyStar3,
} from '@tabler/icons-react'

/**
 * Built-in destinations; user-selected publication shortcuts share the rail separately.
 * `rail: false` pages stay reachable from search and their parent page only.
 */
export const builtinPages = [
	{ href: '/', label: '首页', keywords: 'home', icon: IconHome2, rail: true },
	{ href: '/apps', label: '应用', keywords: 'apps', icon: IconApps, rail: true },
	{ href: '/plugins', label: '插件管理', keywords: 'plugins', icon: IconPuzzle, rail: true },
	{ href: '/logs', label: '日志', keywords: 'logs', icon: IconTerminal2, rail: true },
	{
		href: '/plugin-graph',
		label: '依赖图',
		keywords: 'graph dependencies',
		icon: IconTopologyStar3,
		rail: true,
	},
	{
		href: '/security',
		label: '认证与安全',
		keywords: 'security auth',
		icon: IconShieldLock,
		rail: true,
	},
	{ href: '/security/audit', label: '安全审计', keywords: 'audit', icon: IconHistory, rail: false },
] as const
