// src/components/Layout/Navbar.tsx

import {
	ActionIcon,
	Box,
	Group,
	NavLink,
	Paper,
	ScrollArea,
	Stack,
	Text,
	Tooltip,
	rgba,
	useMantineTheme,
} from '@mantine/core'
import type React from 'react'
import { forwardRef, memo, useEffect, useMemo, useState } from 'react'
import {
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarRightExpand,
} from '@tabler/icons-react'

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
	/** 用于渲染链接的组件，比如 TanStack Router 或 react-router 的 Link */
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
	/** 紧凑模式：仅显示图标，文字隐藏（保留短标签） */
	compact?: boolean
	onCompactToggle?: () => void
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
	compact = false,
	onCompactToggle,
}: NavbarProps) {
	const theme = useMantineTheme()
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
				const rest = others as Omit<React.ComponentPropsWithoutRef<typeof LinkComponent>, 'to'>
				return (
					<LinkComponent to={to} {...rest}>
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
			<Stack gap="md" p="md">
				{onCompactToggle && (
					<>
						{compact ? (
							<Tooltip label="展开侧边栏" openDelay={300}>
								<ActionIcon
									variant="light"
									size="lg"
									radius="xl"
									onClick={onCompactToggle}
									aria-label="展开侧边栏"
									style={{ alignSelf: 'center' }}
								>
									<IconLayoutSidebarRightExpand size={18} stroke={1.8} />
								</ActionIcon>
							</Tooltip>
						) : (
							<Paper
								withBorder
								radius="lg"
								px="md"
								py="sm"
								style={{
									background: theme.colorScheme === 'dark'
										? 'linear-gradient(135deg, rgba(74,89,255,0.2), rgba(110,70,255,0.25))'
										: 'linear-gradient(135deg, rgba(244,246,255,1), rgba(232,238,255,1))',
								}}
							>
								<Group justify="space-between" align="flex-start" gap="sm">
									<div>
										<Text size="xs" c="dimmed" fw={600} tt="uppercase" lh={1}>
											控制台导航
										</Text>
										<Text size="sm" c="dimmed">
											快速切换到不同工作区
										</Text>
									</div>
									<ActionIcon
										variant="white"
										color="brand"
										size="sm"
										onClick={onCompactToggle}
										aria-label="紧凑侧边栏"
									>
										<IconLayoutSidebarLeftCollapse size={16} stroke={1.8} />
									</ActionIcon>
								</Group>
							</Paper>
						)}
					</>
				)}

				{navItems.map(({ label, href, icon, rightSection, exact, disabled }) => {
					const active = getIsActive(pathname, href, exact)
					const normalizedLabel = typeof label === 'string' ? label.trim() : ''
					const showFullLabel = !compact || normalizedLabel.length <= 3
					const activeBg = active
						? theme.colorScheme === 'dark'
							? rgba(theme.colors[theme.primaryColor][8], 0.25)
							: theme.colors[theme.primaryColor][0]
						: undefined
					const borderColor = active
						? theme.colors[theme.primaryColor][4]
						: theme.colorScheme === 'dark'
							? rgba(theme.colors.dark[5], 0.5)
							: rgba(theme.colors.gray[3], 0.8)
					const navLink = (
						<NavLink
							key={href}
							component={LinkWrapper}
							to={href}
							label={showFullLabel ? label : undefined}
							leftSection={icon}
							rightSection={showFullLabel ? rightSection : undefined}
							active={active}
							aria-current={active ? 'page' : undefined}
							aria-label={!showFullLabel ? label : undefined}
							disabled={disabled}
							variant="light"
							styles={{
								root: {
									borderRadius: theme.radius.md,
									border: `1px solid ${borderColor}`,
									backgroundColor: activeBg,
									transition: 'border-color 120ms ease, background-color 120ms ease',
									justifyContent: showFullLabel ? 'flex-start' : 'center',
									paddingInline: showFullLabel ? undefined : theme.spacing.sm,
								},
								body: {
									fontWeight: active ? 600 : 500,
									display: showFullLabel ? undefined : 'none',
								},
							}}
						/>
					)
					return !showFullLabel && typeof label === 'string' ? (
						<Tooltip key={href} label={label} position="right" openDelay={300}>
							{navLink}
						</Tooltip>
					) : (
						navLink
					)
				})}
			</Stack>
		</ScrollArea>
	)
})

export default Navbar
