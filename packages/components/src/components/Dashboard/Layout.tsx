// src/components/Layout/Layout.tsx
import type React from 'react'
import {
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from 'react'
import { AppShell, Box, Overlay } from '@mantine/core'
import { useMantineTheme } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import AppHeader, { type AppHeaderProps } from './AppHeader'
import Navbar, { type NavItem } from './Navbar'

/** Link 形态：最小要求 `to` 和 children；其余 a 属性透传 */
export type LinkLikeProps = {
	to: string
	children: React.ReactNode
} & Omit<React.ComponentPropsWithoutRef<'a'>, 'children' | 'href'>

/** 受控/非受控辅助 Hook（和 Mantine 行为一致） */
function useControllable<T>(opts: {
	value?: T
	defaultValue: T
	onChange?: (v: T) => void
}) {
	const { value, defaultValue, onChange } = opts
	const [inner, setInner] = useState<T>(defaultValue)
	const isControlled = value !== undefined
	const state = isControlled ? (value as T) : inner
	const set = useCallback(
		(v: T | ((prev: T) => T)) => {
			const next = typeof v === 'function' ? (v as (prev: T) => T)(state) : v
			if (!isControlled) setInner(next)
			onChange?.(next)
		},
		[isControlled, onChange, state],
	)
	return [state, set] as const
}

export interface LayoutProps {
	/** —— Header 可插拔 —— */
	header?:
		| React.ReactNode
		| ((ctx: {
				opened: boolean
				toggle: () => void
				isMobile: boolean
		  }) => React.ReactNode)
	headerProps?: Partial<AppHeaderProps>
	headerHeight?: number

	/** —— Navbar 可插拔 —— */
	navbar?:
		| React.ReactNode
		| ((ctx: {
				opened: boolean
				toggle: () => void
				isMobile: boolean
		  }) => React.ReactNode)
	navItems?: NavItem[]
	LinkComponent?: React.ComponentType<LinkLikeProps>

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
	currentPath?: string
	navbarWidth?: number

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
	navbarWidth = 280,
	// Drawer state
	opened: openedProp,
	defaultOpened = true,
	onOpenedChange,
	// Behavior
	collapseDesktop = false,
	closeOnRouteChange = true,
	lockScrollOnMobile = true,
	// Misc
	mainPadding = 'md',
	footerHeight = 0,
	currentPath,
	children,
}: LayoutProps) {
	const theme = useMantineTheme()
	const isMobile = useMediaQuery(
		`(max-width: ${theme.breakpoints.sm})`,
		undefined,
		{
			// SSR 安全：首帧不读 window
			getInitialValueInEffect: true,
		},
	)

	// —— 受控/非受控 —— //
	const [opened, setOpened] = useControllable<boolean>({
		value: openedProp,
		defaultValue: defaultOpened,
		onChange: onOpenedChange,
	})
	const toggle = useCallback(() => setOpened((v) => !v), [setOpened])

	// 移动端切路由自动收起（避免遮罩残留）
	useEffect(() => {
		if (closeOnRouteChange && isMobile && opened) setOpened(false)
		// 仅在 path 变化时触发
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [currentPath])

	// 抽屉打开时，移动端锁定页面滚动（提升交互质感）
	useEffect(() => {
		if (!lockScrollOnMobile) return
		if (!(typeof document !== 'undefined')) return
		const el = document.body
		if (isMobile && opened) {
			const prev = el.style.overflow
			el.style.overflow = 'hidden'
			return () => {
				el.style.overflow = prev
			}
		}
		return
	}, [isMobile, opened, lockScrollOnMobile])

	// —— 用于 render props 的上下文对象 —— //
	const ctx = useMemo(
		() => ({ opened, toggle, isMobile }),
		[opened, toggle, isMobile],
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
			/>
		)
	}, [navbar, navItems, LinkComponent, currentPath, ctx])

	// —— Main 高度：一次算清 —— //
	const mainHeight = `calc(100dvh - ${headerHeight}px - ${footerHeight}px)`

	return (
		<AppShell
			padding={0}
			data-nav-opened={opened ? 'true' : 'false'}
			header={{ height: headerHeight }}
			navbar={{
				width: navbarWidth,
				breakpoint: 'sm',
				// 桌面端是否参与折叠由 collapseDesktop 决定；移动端一定可折叠
				collapsed: {
					mobile: !opened,
					desktop: collapseDesktop ? !opened : false,
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
					opacity={0.2}
					blur={0}
				/>
			)}
		</AppShell>
	)
}
