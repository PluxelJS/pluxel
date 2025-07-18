// AppLayout.tsx
import type React from 'react'
import { forwardRef } from 'react'
import {
	AppShell,
	Burger,
	Group,
	NavLink,
	ScrollArea,
	Stack,
} from '@mantine/core'
import { useDisclosure } from '@mantine/hooks'

export interface NavItem {
	label: string
	href: string
	icon?: React.ReactNode
}
interface LayoutProps {
	navItems: NavItem[]
	LinkComponent: React.ComponentType<{ to: string; children: React.ReactNode }>
	children: React.ReactNode
}

export function AppLayout({ navItems, LinkComponent, children }: LayoutProps) {
	const [mobile, { toggle: toggleMobile }] = useDisclosure()
	const [desktop, { toggle: toggleDesktop }] = useDisclosure(true)

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
		<AppShell
			padding="md"
			header={{ height: 60 }}
			navbar={{
				width: 260,
				breakpoint: 'sm',
				collapsed: { mobile: !mobile, desktop: !desktop },
			}}
		>
			<AppShell.Header>
				<Group justify="apart" px="md" h="100%">
					<Group>
						<Burger opened={mobile} onClick={toggleMobile} hiddenFrom="sm" />
						<Burger opened={desktop} onClick={toggleDesktop} visibleFrom="sm" />
						{/* <IconPuzzle size={30} /> */}
					</Group>
				</Group>
			</AppShell.Header>

			<AppShell.Navbar p="md">
				<ScrollArea h="100%" offsetScrollbars>
					<Stack gap="sm">
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
			</AppShell.Navbar>

			<AppShell.Main>{children}</AppShell.Main>
		</AppShell>
	)
}
