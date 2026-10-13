import {
	IconHome2,
	IconApps,
	IconPuzzle,
	IconTerminal2,
	IconShieldLock,
	IconHistory,
	IconTopologyStar3,
} from '@tabler/icons-react'

/** Official destinations only; published business pages are discovered through Apps. */
export const builtinPages = [
	{ href: '/', label: '首页', description: '运行状态与常用操作', icon: IconHome2 },
	{ href: '/apps', label: '应用', description: '已发布的业务应用', icon: IconApps },
	{ href: '/plugins', label: '插件管理', description: '插件运行状态与配置', icon: IconPuzzle },
	{ href: '/logs', label: '日志', description: '实时日志', icon: IconTerminal2 },
	{ href: '/security', label: '认证与安全', description: '用户、权限与凭据', icon: IconShieldLock },
	{ href: '/security/audit', label: '安全审计', description: '访问与操作记录', icon: IconHistory },
	{
		href: '/plugin-graph',
		label: '依赖图',
		description: '插件依赖与运行拓扑',
		icon: IconTopologyStar3,
	},
] as const
