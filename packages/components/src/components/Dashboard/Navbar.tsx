// src/components/Layout/Navbar.tsx
import type React from 'react'
import { forwardRef, memo, useEffect, useMemo, useState } from 'react'
import { ScrollArea, Stack, NavLink } from '@mantine/core'

export interface NavItem {
	label: string
	href: string
	/** 兼容旧字段：图标默认放在左侧；如需放右侧，传 rightSection */
	icon?: React.ReactNode
	/** 可选：右侧区域（徽标/快捷键/状态灯等） */
	rightSection?: React.ReactNode
	/** 可选：是否严格匹配路径（默认前缀匹配） */
	exact?: boolean
	/** 可选：禁用条目 */
	disabled?: boolean
}

type LinkLikeProps = {
	to: string
	children: React.ReactNode
} & React.ComponentPropsWithoutRef<'a'>

export interface NavbarProps {
	/** 导航项数组 */
	navItems: NavItem[]
	/** 用于渲染链接的组件，比如 wouter 的 Link 或 react-router 的 Link */
	LinkComponent: React.ComponentType<LinkLikeProps>
	/**
	 * 可选：当前路径（更准确、更 SSR 友好）。
	 * 若不传，将在客户端以 window.location.pathname 为准（避免 SSR 水位不一致）。
	 */
	currentPath?: string
	/**
	 * 可选：自定义激活判断逻辑
	 */
	getIsActive?: (currentPath: string, href: string, exact?: boolean) => boolean
}

function defaultIsActive(pathname: string, href: string, exact?: boolean) {
	if (!pathname) return false
	if (exact) return pathname === href
	// 前缀匹配，避免 /a 把 /ab 也激活
	const base = href.endsWith('/') ? href.slice(0, -1) : href
	return pathname === base || pathname.startsWith(`${base}/`)
}

const Navbar = memo(function Navbar({
	navItems,
	LinkComponent,
	currentPath,
	getIsActive = defaultIsActive,
}: NavbarProps) {
	// —— 激活态：优先使用 props.currentPath；否则仅在挂载后读取一次 pathname，避免 SSR 水位差 ——
	const [pathname, setPathname] = useState<string>('')
	useEffect(() => {
		if (currentPath != null) {
			setPathname(currentPath)
			return
		}
		if (typeof window !== 'undefined') {
			setPathname(window.location.pathname)
			// 监听后退/前进：尽量保持激活态正确（无需打补丁 pushState）
			const onPop = () => setPathname(window.location.pathname)
			window.addEventListener('popstate', onPop)
			window.addEventListener('hashchange', onPop)
			return () => {
				window.removeEventListener('popstate', onPop)
				window.removeEventListener('hashchange', onPop)
			}
		}
	}, [currentPath])

	// —— 把 LinkComponent 包装成 Mantine NavLink 识别的组件（转发 ref、支持传入其他 a 属性） ——
	const LinkWrapper = useMemo(
		() =>
			forwardRef<HTMLAnchorElement, LinkLikeProps>(function LinkWrapper(
				{ to, children, ...others },
				ref,
			) {
				return (
					<LinkComponent
						to={to}
						ref={ref as any}
						{...(others as unknown as React.ComponentPropsWithoutRef<
							typeof LinkComponent
						>)}
					>
						{children}
					</LinkComponent>
				)
			}),
		[LinkComponent],
	)
	LinkWrapper.displayName = 'NavLinkWrapper'

	return (
		<ScrollArea
			h="100%"
			type="auto"
			offsetScrollbars
			// 防止在 AppShell.Navbar 内出现“嵌套滚动导致的意外溢出”
			style={{ minHeight: 0 }}
		>
			<Stack gap="xs" p="sm">
				{navItems.map(
					({ label, href, icon, rightSection, exact, disabled }) => {
						const active = getIsActive(pathname, href, exact)
						return (
							<NavLink
								key={href}
								component={LinkWrapper}
								to={href}
								label={label}
								leftSection={icon}
								rightSection={rightSection}
								active={active}
								aria-current={active ? 'page' : undefined}
								disabled={disabled}
								variant="light"
								// 提升可点击面积 & 保持紧凑
								styles={{
									root: { borderRadius: 8 },
									body: { fontWeight: active ? 600 : 500 },
								}}
							/>
						)
					},
				)}
			</Stack>
		</ScrollArea>
	)
})

export default Navbar
