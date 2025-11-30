import {
	localStorageColorSchemeManager,
	MantineProvider,
	useComputedColorScheme,
} from '@mantine/core'
import { ModalsProvider } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import { Outlet, useRouterState } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Layout, type NavItem } from '../../components'
import {
	type ExtensionContext,
	ExtensionPoints,
	ExtensionProvider,
	useExtensionSurface,
} from '../../extension'
import { useDynamicTheme } from '../../useDynamicTheme'
import { LAST_ROUTE_KEY } from '../constants'
import { ExtensionLoader } from '../ExtensionLoader'
import { Header } from '../Header'
import { baseNavItems, buildExtensionNavItems } from '../navigation/navConfig'
import { NotificationCenterProvider } from '../notifications/NotificationCenterProvider'
import { RouterLinkAdapter } from '../RouterLinkAdapter'

const colorSchemeManager = localStorageColorSchemeManager({
	key: 'pluxel-color-scheme',
})

export function RootShell() {
	const { theme } = useDynamicTheme()

	return (
		<MantineProvider
			theme={theme}
			colorSchemeManager={colorSchemeManager}
			withCssVariables
			withGlobalClasses={false}
			deduplicateCssVariables={false}
		>
			<RootShellContent />
		</MantineProvider>
	)
}

function RootShellContent() {
	const pathname = useRouterState({ select: (state) => state.location.pathname })
	const colorScheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const navbarSurface = useExtensionSurface(ExtensionPoints.NavbarItems)
	const [runningPlugins, setRunningPlugins] = useState<ReadonlySet<string>>(() => new Set())

	const handleRunningPluginsChange = useCallback((next: ReadonlySet<string>) => {
		setRunningPlugins((prev) => {
			if (prev.size === next.size) {
				let identical = true
				for (const name of prev) {
					if (!next.has(name)) {
						identical = false
						break
					}
				}
				if (identical) {
					return prev
				}
			}
			return new Set(next)
		})
	}, [])

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

	const extensionContext = useMemo<ExtensionContext>(
		() => ({
			pathname,
			colorScheme,
			runningPlugins,
		}),
		[pathname, colorScheme, runningPlugins],
	)

	return (
		<ExtensionProvider value={extensionContext}>
			<NotificationCenterProvider>
				<ModalsProvider>
					<Notifications position="top-center" />
					<ExtensionLoader
						pollInterval={5000}
						onRunningPluginsChange={handleRunningPluginsChange}
					/>
					<Layout
						header={({ toggle }) => <Header onMenu={toggle} />}
						navItems={combinedNavItems}
						LinkComponent={RouterLinkAdapter}
						currentPath={pathname}
						footerHeight={0}
					>
						<Outlet />
					</Layout>
				</ModalsProvider>
			</NotificationCenterProvider>
		</ExtensionProvider>
	)
}
