// src/components/Layout/Navbar.tsx
import type React from 'react'
import { forwardRef } from 'react'
import { ScrollArea, Stack, NavLink } from '@mantine/core'

export interface NavItem {
	label: string
	href: string
	icon?: React.ReactNode
}

export interface NavbarProps {
	/** 导航项数组 */
	navItems: NavItem[]
	/** 用于渲染链接的组件，比如 react-router 的 Link */
	LinkComponent: React.ComponentType<{ to: string; children: React.ReactNode }>
}

export default function Navbar({ navItems, LinkComponent }: NavbarProps) {
	// 把 LinkComponent 包装成 NavLink 能识别的形式
	const LinkWrapper = forwardRef<
		HTMLAnchorElement,
		{ to: string; children: React.ReactNode }
	>(({ to, children, ...others }, ref) => (
		<LinkComponent to={to} ref={ref} {...(others as any)}>
			{children}
		</LinkComponent>
	))
	LinkWrapper.displayName = 'NavLinkWrapper'

	return (
		<ScrollArea h="100%" offsetScrollbars>
			<Stack gap="md">
				{navItems.map(({ label, href, icon }) => (
					<NavLink
						key={href}
						component={LinkWrapper}
						to={href}
						label={label}
						rightSection={icon}
					/>
				))}
			</Stack>
		</ScrollArea>
	)
}
