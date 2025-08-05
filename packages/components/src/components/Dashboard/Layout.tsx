import React, { type ReactNode } from 'react'
import { AppShell, Overlay } from '@mantine/core'
import AppHeader from './AppHeader'
import Navbar, { type NavItem } from './Navbar'
import { Link } from 'wouter'

interface LayoutProps {
	navItems: NavItem[]
	opened?: boolean
	onOverlayClick?: () => void
	children: ReactNode
}

export function Layout({ opened = false, navItems, children }: LayoutProps) {
	return (
		<AppShell
			padding="md"
			navbar={{
				width: 280,
				breakpoint: 'sm',
				collapsed: { mobile: !opened, desktop: !opened },
			}}
			header={{ height: 60 }}
		>
			<AppShell.Header>
				<AppHeader title="示例应用头部" />
			</AppShell.Header>

			<AppShell.Navbar>
				<Navbar navItems={navItems} LinkComponent={Link} />
			</AppShell.Navbar>

			<AppShell.Main>{children}</AppShell.Main>
		</AppShell>
	)
}
