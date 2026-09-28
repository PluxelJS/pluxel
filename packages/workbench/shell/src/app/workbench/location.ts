import { parsePluginDetailHref, parseWorkbenchHref } from '../../workbench/paths'

export type BuiltinWorkbenchIcon = 'home' | 'logs' | 'security' | 'plugins' | 'plugin-graph'

export type WorkbenchLocationHeader = Readonly<{
	eyebrow: string
	title: string
	subtitle?: string
}>

export type WorkbenchLocationDescriptor = Readonly<{
	path: string
	title: string
	meta?: string
	header: WorkbenchLocationHeader
}>

export type BuiltinWorkbenchRoute = WorkbenchLocationDescriptor &
	Readonly<{
		icon: BuiltinWorkbenchIcon
		navigation: boolean
	}>

export const BUILTIN_WORKBENCH_ROUTES: readonly BuiltinWorkbenchRoute[] = Object.freeze([
	{
		path: '/',
		title: '首页',
		meta: 'Workbench',
		header: { eyebrow: 'Workbench', title: '首页', subtitle: '概览与快速入口' },
		icon: 'home',
		navigation: true,
	},
	{
		path: '/logs',
		title: '日志',
		meta: 'Runtime',
		header: { eyebrow: 'Logs', title: '日志', subtitle: '运行时流与诊断' },
		icon: 'logs',
		navigation: true,
	},
	{
		path: '/security',
		title: '安全',
		meta: 'Host',
		header: { eyebrow: 'Security', title: '安全', subtitle: '访问验证与加密存储' },
		icon: 'security',
		navigation: true,
	},
	{
		path: '/security/audit',
		title: '审计事件',
		meta: 'Security',
		header: { eyebrow: 'Security', title: '安全', subtitle: '访问验证与加密存储' },
		icon: 'security',
		navigation: false,
	},
	{
		path: '/plugins',
		title: '插件',
		meta: 'Overview',
		header: { eyebrow: 'Plugins', title: '插件', subtitle: '浏览、配置与运行验证' },
		icon: 'plugins',
		navigation: true,
	},
	{
		path: '/plugin-graph',
		title: '依赖图',
		meta: 'Plugins',
		header: {
			eyebrow: 'Plugins',
			title: '依赖图',
			subtitle: '查看 Plugin provider 与 consumer 关系',
		},
		icon: 'plugin-graph',
		navigation: true,
	},
])

const builtinRouteByPath = new Map(BUILTIN_WORKBENCH_ROUTES.map((route) => [route.path, route]))

function builtinRoute(path: string): BuiltinWorkbenchRoute {
	const route = builtinRouteByPath.get(path)
	if (!route) throw new Error(`missing builtin Workbench route: ${path}`)
	return route
}

export function resolveWorkbenchLocation(pathname: string): WorkbenchLocationDescriptor {
	const path = pathname || '/'
	const builtin = builtinRouteByPath.get(path)
	if (builtin) return builtin

	const pluginRoute = parsePluginDetailHref(path)
	if (pluginRoute) {
		const title = pluginRoute.target.definition.exportName
		const tail = pluginRoute.path.slice(1)
		return {
			path,
			title,
			meta: tail ? (tail === 'config' ? '配置' : tail.replaceAll('/', ' / ')) : '概览',
			header: {
				eyebrow: 'Plugins',
				title,
				subtitle: tail === 'config' ? '配置与运行上下文' : '插件工作页',
			},
		}
	}

	if (path.startsWith('/plugins/')) {
		return { ...builtinRoute('/plugins'), path }
	}
	if (path.startsWith('/plugin-graph/')) {
		return { ...builtinRoute('/plugin-graph'), path }
	}
	if (path.startsWith('/security/')) {
		return { ...builtinRoute('/security'), path }
	}
	if (path.startsWith('/logs/')) {
		return { ...builtinRoute('/logs'), path }
	}

	const workbenchRoute = parseWorkbenchHref(path)
	if (workbenchRoute?.frame === 'shell') {
		return {
			path,
			title: workbenchRoute.target.definition.exportName,
			meta: 'Workbench',
			header: {
				eyebrow: 'Workbench',
				title: workbenchRoute.target.definition.exportName,
				subtitle: workbenchRoute.path || '插件页面',
			},
		}
	}

	const section = path.split('/').find(Boolean) ?? '页面'
	return {
		path,
		title: section,
		meta: path,
		header: { eyebrow: 'Workbench', title: '控制台', subtitle: path },
	}
}

export function isPluginWorkbenchLocation(pathname: string) {
	return pathname === '/plugins' || pathname.startsWith('/plugins/')
}

export function isWorkbenchActivityActive(pathname: string, href: string, exact?: boolean) {
	if (exact) return pathname === href
	return pathname === href || pathname.startsWith(`${href}/`)
}
