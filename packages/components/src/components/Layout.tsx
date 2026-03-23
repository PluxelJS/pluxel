// src/components/Layout/Layout.tsx

import {
	AppShell,
	Box,
	Overlay,
	rgba,
	useComputedColorScheme,
	useMantineTheme,
} from '@mantine/core'
import { useLocalStorage, useMediaQuery } from '@mantine/hooks'
import type React from 'react'
import { type ReactNode, useCallback, useEffect, useMemo } from 'react'
import AppHeader, { type AppHeaderProps } from './AppHeader'
import Navbar, { type NavItem } from './Navbar'
import { getPatternStyle } from '../theme'
import { useControllable } from '../hooks'

/** Link 形态：最小要求 `to` 和 children；其余 a 属性透传 */
export type LinkLikeProps = {
	to: string
	children: React.ReactNode
} & Omit<React.ComponentPropsWithoutRef<'a'>, 'children' | 'href'>

type LayoutRenderCtx = {
	opened: boolean
	toggle: () => void
	isMobile: boolean
	compact: boolean
	toggleCompact: () => void
}

export interface LayoutProps {
	/** —— Header 可插拔 —— */
	header?: React.ReactNode | ((ctx: LayoutRenderCtx) => React.ReactNode)
	headerProps?: Partial<AppHeaderProps>
	headerHeight?: number

	/** —— Navbar 可插拔 —— */
	navbar?: React.ReactNode | ((ctx: LayoutRenderCtx) => React.ReactNode)
	navItems?: NavItem[]
	LinkComponent?: React.ComponentType<LinkLikeProps>
	/** Navbar 底部区域（紧贴主题设置附近） */
	navbarFooter?: React.ReactNode | ((ctx: LayoutRenderCtx) => React.ReactNode)

	/** —— 抽屉开合（可控/非控） —— */
	opened?: boolean
	defaultOpened?: boolean
	onOpenedChange?: (opened: boolean) => void

	/** —— 行为开关 —— */
	/** 桌面端是否也允许折叠（默认：false，仅移动端可折叠） */
	collapseDesktop?: boolean
	/** 移动端切换路由时自动收起（默认：true） */
	closeOnRouteChange?: boolean
	/** 移动端抽屉打开时锁定 <body> 滚动（默认：true） */
	lockScrollOnMobile?: boolean

	/** —— 其他 —— */
	mainPadding?: string | number
	footerHeight?: number
	footer?: React.ReactNode | ((ctx: LayoutRenderCtx) => React.ReactNode)
	currentPath?: string
	navbarWidth?: number
	compactNavbarWidth?: number

	children: ReactNode
}

const DEFAULT_HEADER_HEIGHT = 60

export function Layout({
	// Header
	header,
	headerProps,
	headerHeight = DEFAULT_HEADER_HEIGHT,
	// Navbar
	navbar,
	navItems,
	LinkComponent,
	navbarFooter,
	navbarWidth = 280,
	compactNavbarWidth = 84,
	// Drawer state
	opened: openedProp,
	defaultOpened = true,
	onOpenedChange,
	// Behavior
	collapseDesktop = true,
	closeOnRouteChange = true,
	lockScrollOnMobile = true,
	// Misc
	mainPadding = 'md',
	footerHeight = 0,
	footer,
	currentPath,
	children,
}: LayoutProps) {
	const theme = useMantineTheme()
	const colorScheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const isMobile = useMediaQuery(`(max-width: ${theme.breakpoints.sm})`, undefined, {
		// SSR 安全：首帧不读 window
		getInitialValueInEffect: true,
	})
	const [storedOpened, setStoredOpened] = useLocalStorage<boolean>({
		key: 'pluxel:layout:sidebar-open',
		defaultValue: defaultOpened,
		getInitialValueInEffect: true,
	})
	const [compactNavbar, setCompactNavbar] = useLocalStorage<boolean>({
		key: 'pluxel:layout:sidebar-compact',
		defaultValue: false,
		getInitialValueInEffect: true,
	})

	// —— 受控/非受控 —— //
	const [opened, setOpened] = useControllable<boolean>({
		value: openedProp,
		defaultValue: storedOpened,
		onChange: (value) => {
			setStoredOpened(value)
			onOpenedChange?.(value)
		},
	})
	const toggle = useCallback(() => setOpened((v) => !v), [setOpened])
	const toggleCompact = useCallback(() => setCompactNavbar((v) => !v), [setCompactNavbar])

	// 移动端切路由自动收起（避免遮罩残留）
	useEffect(() => {
		if (closeOnRouteChange && isMobile && opened) setOpened(false)
		// 仅在 path 变化时触发
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [currentPath])

	// 抽屉打开时，移动端锁定页面滚动（提升交互质感）
	useEffect(() => {
		if (!lockScrollOnMobile) return undefined
		if (!(typeof document !== 'undefined')) return undefined
		const el = document.body
		if (isMobile && opened) {
			const prev = el.style.overflow
			el.style.overflow = 'hidden'
			return () => {
				el.style.overflow = prev
			}
		}
		return undefined
	}, [isMobile, opened, lockScrollOnMobile])

	// —— 用于 render props 的上下文对象 —— //
	const ctx = useMemo(
		() => ({ opened, toggle, isMobile, compact: compactNavbar, toggleCompact }),
		[opened, toggle, isMobile, compactNavbar, toggleCompact],
	)

	// —— 组装 Header —— //
	const headerNode = useMemo(() => {
		if (typeof header === 'function') return header(ctx)
		if (header) return header

		const props: AppHeaderProps = {
			withDivider: false,
			// 桌面端是否展示 Burger 取决于是否允许折叠
			showBurger: isMobile || collapseDesktop,
			onBurgerClick: toggle,
			...headerProps,
		}
		return <AppHeader {...props} />
	}, [header, headerProps, ctx, isMobile, collapseDesktop, toggle])

	const footerNode = useMemo(() => {
		if (!footer) return null
		if (typeof footer === 'function') return footer(ctx)
		return footer
	}, [footer, ctx])

	const navbarFooterNode = useMemo(() => {
		if (!navbarFooter) return null
		if (typeof navbarFooter === 'function') return navbarFooter(ctx)
		return navbarFooter
	}, [navbarFooter, ctx])

	// —— 组装 Navbar —— //
	const navbarNode = useMemo(() => {
		if (typeof navbar === 'function') return navbar(ctx)
		if (navbar) return navbar
		if (!navItems?.length || !LinkComponent) return null
		return (
			<Navbar
				navItems={navItems}
				LinkComponent={LinkComponent}
				currentPath={currentPath}
				compact={compactNavbar}
				onCompactToggle={toggleCompact}
				footer={navbarFooterNode}
			/>
		)
	}, [
		navbar,
		navItems,
		LinkComponent,
		currentPath,
		ctx,
		compactNavbar,
		toggleCompact,
		navbarFooterNode,
	])

	// —— Main 高度：一次算清 —— //
	const mainHeight = `calc(100dvh - ${headerHeight}px - ${footerHeight}px)`

	// 优化后的边框颜色：降低视觉权重
	const borderColor =
		colorScheme === 'dark'
			? rgba(theme.colors.gray[8], 0.4) // 从 0.65 降低到 0.4
			: rgba(theme.colors.gray[3], 0.45) // 从 0.8 降低到 0.45
	const pattern = getPatternStyle(colorScheme === 'dark' ? 'dark' : 'light')

	const computedNavbarWidth = compactNavbar ? compactNavbarWidth : navbarWidth
	const desktopCollapsed = collapseDesktop ? !opened : false

	return (
		<AppShell
			padding={0}
			data-nav-opened={opened ? 'true' : 'false'}
			data-nav-compact={compactNavbar ? 'true' : undefined}
			header={{ height: headerHeight }}
			footer={footerNode ? { height: footerHeight } : undefined}
			navbar={{
				width: computedNavbarWidth,
				breakpoint: 'sm',
				// 桌面端是否参与折叠由 collapseDesktop 决定；移动端一定可折叠
				collapsed: {
					mobile: !opened,
					desktop: desktopCollapsed,
				},
			}}
			styles={{
				main: {
					backgroundColor: pattern.backgroundColor,
					backgroundImage: pattern.backgroundImage,
					backgroundSize: pattern.backgroundSize,
					backgroundPosition: pattern.backgroundPosition,
					minHeight: '100dvh',
				},
				navbar: {
					borderRight: `1px solid ${borderColor}`,
				},
				header: {
					borderBottom: `1px solid ${borderColor}`,
				},
			}}
		>
			{/* Header */}
			<AppShell.Header>{headerNode}</AppShell.Header>

			{/* Navbar（可空） */}
			{navbarNode && <AppShell.Navbar>{navbarNode}</AppShell.Navbar>}

			{/* Main：外层定高 + 内层 flex 托底，子组件可自由 h="100%" 或自适应 */}
			<AppShell.Main>
				<Box
					h={mainHeight}
					p={mainPadding}
					// 防止“撑开 100%”带来的外滚；确保内部自洽滚动
					style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}
				>
					<Box
						style={{
							flex: 1,
							minHeight: 0, // 关键：允许内部滚动容器正确计算高度
							display: 'flex',
							flexDirection: 'column',
						}}
					>
						{children}
					</Box>
				</Box>
			</AppShell.Main>

			{/* Footer（可空） */}
			{footerNode && <AppShell.Footer>{footerNode}</AppShell.Footer>}

			{/* 移动端抽屉遮罩（只盖 Main，不遮 Header） */}
			{opened && isMobile && (
				<Overlay
					onClick={() => setOpened(false)}
					role="button"
					aria-label="关闭侧边栏"
					style={{
						position: 'fixed',
						top: headerHeight,
						left: 0,
						right: 0,
						bottom: 0,
					}}
					color={theme.black}
					opacity={colorScheme === 'dark' ? 0.6 : 0.3}
					blur={0}
				/>
			)}
		</AppShell>
	)
}
