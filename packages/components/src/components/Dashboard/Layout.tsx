// src/components/Layout/Layout.tsx
import type React from 'react'
import { type ReactNode, useCallback, useMemo, useState } from 'react'
import { AppShell, Box, Overlay } from '@mantine/core'
import { useMantineTheme } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import AppHeader, { type AppHeaderProps } from './AppHeader'
import Navbar, { type NavItem } from './Navbar'

/** Link 形态：最小要求 `to` 和 children；其余 a 属性透传 */
export type LinkLikeProps = {
	to: string
	children: React.ReactNode
} & React.ComponentPropsWithoutRef<'a'>

export interface LayoutProps {
	/** —— Header 可插拔 —— */
	/** 自定义 Header（节点或渲染函数），优先级高于 headerProps + 默认 AppHeader */
	header?:
		| React.ReactNode
		| ((ctx: {
				opened: boolean
				toggle: () => void
				isMobile: boolean
		  }) => React.ReactNode)
	/** 传给默认 AppHeader 的属性（非必填） */
	headerProps?: Partial<AppHeaderProps>
	/** Header 高度（用于计算 Main 高度） */
	headerHeight?: number

	/** —— Navbar 可插拔 —— */
	/** 自定义 Navbar（节点或渲染函数），优先于 navItems + LinkComponent 的默认 Navbar */
	navbar?:
		| React.ReactNode
		| ((ctx: {
				opened: boolean
				toggle: () => void
				isMobile: boolean
		  }) => React.ReactNode)
	/** 默认 Navbar 的数据源（若传入则使用默认 Navbar，除非你提供了 navbar 覆盖） */
	navItems?: NavItem[]
	/** 默认 Navbar 所需的 Link 组件 */
	LinkComponent?: React.ComponentType<LinkLikeProps>

	/** —— 抽屉开合（可控/非控） —— */
	opened?: boolean
	defaultOpened?: boolean
	onOpenedChange?: (opened: boolean) => void

	/** —— 其他 —— */
	/** Main 内边距放在内层，计算简单；默认 md */
	mainPadding?: string | number
	/** 如果有 Footer，高度写这里（会参与 Main 高度计算） */
	footerHeight?: number
	/** 可选：当前路径，传了可提升 Navbar 激活态准确性 */
	currentPath?: string

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
	// Drawer state
	opened: openedProp,
	defaultOpened = true,
	onOpenedChange,
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
	const [openedUncontrolled, setOpenedUncontrolled] = useState(defaultOpened)
	const opened = openedProp ?? openedUncontrolled
	const setOpened = useCallback(
		(next: boolean) => {
			if (openedProp == null) setOpenedUncontrolled(next)
			onOpenedChange?.(next)
		},
		[openedProp, onOpenedChange],
	)
	const toggle = useCallback(() => setOpened(!opened), [opened, setOpened])

	// —— 组装 Header —— //
	const headerNode = useMemo(() => {
		if (typeof header === 'function')
			return header({ opened, toggle, isMobile })
		if (header) return header

		// 默认 Header：自动给出汉堡按钮、支持分隔线、可插槽 right
		const props: AppHeaderProps = {
			withDivider: false,
			showBurger: isMobile,
			onBurgerClick: toggle,
			...headerProps,
		}
		return <AppHeader {...props} />
	}, [header, headerProps, opened, toggle, isMobile])

	// —— 组装 Navbar —— //
	const navbarNode = useMemo(() => {
		if (typeof navbar === 'function')
			return navbar({ opened, toggle, isMobile })
		if (navbar) return navbar
		if (!navItems?.length || !LinkComponent) return null
		return (
			<Navbar
				navItems={navItems}
				LinkComponent={LinkComponent}
				currentPath={currentPath}
			/>
		)
	}, [navbar, navItems, LinkComponent, currentPath, opened, toggle, isMobile])

	// —— Main 高度：一次算清 —— //
	const mainHeight = `calc(100dvh - ${headerHeight}px - ${footerHeight}px)`

	return (
		<AppShell
			padding={0}
			header={{ height: headerHeight }}
			navbar={{
				width: 280,
				breakpoint: 'sm',
				collapsed: { mobile: !opened, desktop: !opened },
			}}
			// 如需 Footer：外层 AppShell 仍可加 footer={{ height: footerHeight }}
		>
			{/* Header */}
			<AppShell.Header>{headerNode}</AppShell.Header>

			{/* Navbar（可空） */}
			{navbarNode && <AppShell.Navbar>{navbarNode}</AppShell.Navbar>}

			{/* Main：外层定高 + 内层 flex 托底，子组件随意 h="100%" */}
			<AppShell.Main>
				<Box
					h={mainHeight}
					p={mainPadding}
					style={{ display: 'flex', flexDirection: 'column' }}
				>
					<Box
						style={{
							flex: 1,
							minHeight: 0,
							display: 'flex',
							flexDirection: 'column',
						}}
					>
						{children}
					</Box>
				</Box>
			</AppShell.Main>

			{/* 移动端抽屉遮罩（只盖住 Main，不遮 Header） */}
			{opened && isMobile && (
				<Overlay
					onClick={() => setOpened(false)}
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
