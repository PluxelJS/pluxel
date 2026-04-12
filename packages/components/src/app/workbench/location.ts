import type { WorkbenchSectionId } from './state'

function decodeSegment(value: string) {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}

export function getWorkbenchSectionTitle(pathname: string) {
	if (!pathname || pathname === '/') {
		return { eyebrow: 'Workbench', title: '首页', subtitle: '概览与快速入口' }
	}
	if (pathname.startsWith('/plugins')) {
		const match = pathname.match(/^\/plugins\/([^/]+)(?:\/(.*))?$/)
		if (match?.[1]) {
			const pluginName = decodeSegment(match[1])
			const meta = match[2] === 'config' ? '配置与运行上下文' : '插件工作页'
			return { eyebrow: 'Plugins', title: pluginName, subtitle: meta }
		}
		return { eyebrow: 'Plugins', title: '插件', subtitle: '浏览、配置与运行验证' }
	}
	if (pathname.startsWith('/packages')) {
		return { eyebrow: 'Packages', title: '包管理', subtitle: '依赖、安装与同步' }
	}
	if (pathname.startsWith('/logs')) {
		return { eyebrow: 'Logs', title: '日志', subtitle: '运行时流与诊断' }
	}
	if (pathname.startsWith('/ops')) {
		return { eyebrow: 'Ops', title: 'Ops Explorer', subtitle: '宿主控制面与动态操作分组' }
	}
	return { eyebrow: 'Workbench', title: '控制台', subtitle: pathname }
}

export function getWorkbenchSectionId(pathname: string): WorkbenchSectionId {
	if (!pathname || pathname === '/') return 'home'
	if (pathname.startsWith('/plugins')) return 'plugins'
	if (pathname.startsWith('/packages')) return 'packages'
	if (pathname.startsWith('/logs')) return 'logs'
	if (pathname.startsWith('/ops')) return 'ops'
	return 'other'
}

export function isWorkbenchActivityActive(pathname: string, href: string, exact?: boolean) {
	if (exact) return pathname === href
	return pathname === href || pathname.startsWith(`${href}/`)
}
