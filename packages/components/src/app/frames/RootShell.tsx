import { Stack } from '@mantine/core'
import { Outlet } from '@tanstack/react-router'
import { useEffect, useMemo } from 'react'
import { Layout, type NavItem } from '../../components'
import { ExtensionPoints, useExtensionSurface } from '../../extension'
import { LAST_ROUTE_KEY } from '../constants'
import { Header } from '../Header'
import { baseNavItems, buildExtensionNavItems } from '../navigation/navConfig'
import { RouterLinkAdapter } from '../RouterLinkAdapter'
import { useCurrentPathname } from '../router/useCurrentRoute'
import { NavbarFooterActions } from '../layout/NavbarFooterActions'

export function RootShell() {
	const pathname = useCurrentPathname()
	const navbarSurface = useExtensionSurface(ExtensionPoints.NavbarItems, { renderNodes: false })
	const navbarFooterSurface = useExtensionSurface(ExtensionPoints.NavbarFooter)
	const statusBarSurface = useExtensionSurface(ExtensionPoints.GlobalStatusBar)

	const extensionNavItems = useMemo<NavItem[]>(() => {
		if (navbarSurface.items.length === 0) return []
		const entries = navbarSurface.items.map(({ meta }) => ({
			id: meta.id,
			label:
				typeof meta.label === 'string' && meta.label.length > 0
					? (meta.label as string)
					: undefined,
			href:
				typeof meta.href === 'string' && meta.href.length > 0 ? (meta.href as string) : undefined,
			icon: meta.icon,
			rightSection: meta.rightSection,
			exact: meta.exact === true,
		}))
		return buildExtensionNavItems(entries)
	}, [navbarSurface.items])

	const combinedNavItems = useMemo(
		() => [...baseNavItems, ...extensionNavItems],
		[extensionNavItems],
	)

	useEffect(() => {
		if (!pathname || pathname === '/') return
		if (typeof window === 'undefined') return
		try {
			window.localStorage.setItem(LAST_ROUTE_KEY, pathname)
		} catch {}
	}, [pathname])

	return (
		<Layout
			header={({ toggle }) => <Header onMenu={toggle} />}
			navItems={combinedNavItems}
			LinkComponent={RouterLinkAdapter}
			currentPath={pathname}
			navbarFooter={({ compact }) => (
				<Stack gap="sm">
					<NavbarFooterActions compact={compact} />
					{navbarFooterSurface.hasFill ? <div>{navbarFooterSurface.nodes}</div> : null}
				</Stack>
			)}
			footerHeight={statusBarSurface.hasFill ? 44 : 0}
			footer={
				statusBarSurface.hasFill ? (
					<div
						style={{
							height: 44,
							display: 'flex',
							alignItems: 'center',
							gap: 8,
							padding: '0 12px',
						}}
					>
						{statusBarSurface.nodes}
					</div>
				) : null
			}
		>
			<Outlet />
		</Layout>
	)
}
