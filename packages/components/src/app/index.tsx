import {
	Badge,
	Box,
	Button,
	Center,
	Grid,
	Group,
	MantineProvider,
	Paper,
	Stack,
	Text,
	Title,
	useComputedColorScheme,
} from '@mantine/core'
import { ModalsProvider } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import {
	createBrowserHistory,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	type RouterHistory,
	RouterProvider,
	useNavigate,
	useRouterState,
} from '@tanstack/react-router'
import { useEffect, useState, type ReactNode } from 'react'
import { Layout, type NavItem } from '../components'
import {
	IconBolt,
	IconClockPlay,
	IconHome2,
	IconHistory,
	IconKeyboard,
	IconPackages,
	IconPlugConnected,
	IconPuzzle,
} from '@tabler/icons-react'
import { ClientOnly } from './ClientOnly'
import { Header } from './Header'
import { LiveLog } from './log_viewer/LiveLog'
import { PackageManagerPage } from './packages/PackageManagerPage'
import { Plugin } from './plugins/Plugin'
import { PluginsLayout } from './plugins/PluginsLayout'
import { RouterLinkAdapter } from './RouterLinkAdapter'
import { HOME_MANUAL_KEY, LAST_ROUTE_KEY } from './constants'
import { getPatternStyle } from '../patterns'

const navItems: NavItem[] = [
	{ label: '首页', href: '/', exact: true, icon: <IconHome2 size={18} stroke={1.7} /> },
	{ label: '日志', href: '/logs', icon: <IconHistory size={18} stroke={1.7} /> },
	{ label: '包管理', href: '/packages', icon: <IconPackages size={18} stroke={1.7} /> },
	{ label: '插件', href: '/plugins', icon: <IconPuzzle size={18} stroke={1.7} /> },
]

function RootAppLayout() {
	const pathname = useRouterState({ select: (state) => state.location.pathname })

	useEffect(() => {
		if (!pathname || pathname === '/') return
		if (typeof window === 'undefined') return
		try {
			window.localStorage.setItem(LAST_ROUTE_KEY, pathname)
		} catch {}
	}, [pathname])

	return (
		<MantineProvider withGlobalClasses={false} deduplicateCssVariables={false}>
			<ModalsProvider>
				<Notifications position="top-center" />
				<Layout
					header={({ toggle }) => <Header onMenu={toggle} />}
					navItems={navItems}
					LinkComponent={RouterLinkAdapter}
					currentPath={pathname}
					footerHeight={0}
				>
					<Outlet />
				</Layout>
			</ModalsProvider>
		</MantineProvider>
	)
}

function PluginsRouteComponent() {
	return <PluginsLayout />
}

function PackagesRouteComponent() {
	return (
		<ClientOnly>
			<PackageManagerPage />
		</ClientOnly>
	)
}

function PluginsPlaceholder() {
	return (
		<Center style={{ flex: 1 }}>
			<Stack align="center" gap="xs">
				<Title order={4}>欢迎探索插件</Title>
				<Text c="dimmed">在左侧选择一个插件即可查看详情和配置。</Text>
			</Stack>
		</Center>
	)
}

function PluginDetailRouteComponent() {
	const { name: rawName } = pluginDetailRoute.useParams()
	let name = rawName
	try {
		name = decodeURIComponent(rawName)
	} catch {
		// ignore decode failure, fallback to raw string
	}
	return (
		<ClientOnly>
			<Plugin pluginName={name} />
		</ClientOnly>
	)
}

function HomeRouteComponent() {
	const navigate = useNavigate()
	const [showIntro, setShowIntro] = useState(false)
	const [lastRoute, setLastRoute] = useState<string | null>(null)

	useEffect(() => {
		if (typeof window === 'undefined') return
		const manual = window.sessionStorage.getItem(HOME_MANUAL_KEY)
		const last = window.localStorage.getItem(LAST_ROUTE_KEY)
		setLastRoute(last)
		if (manual) {
			window.sessionStorage.removeItem(HOME_MANUAL_KEY)
			setShowIntro(true)
			return
		}
		if (last && last !== '/' && last !== window.location.pathname) {
			navigate({ to: last as never, replace: true })
			return
		}
		setShowIntro(true)
	}, [navigate])

	if (!showIntro) {
		return (
			<Center h="100%">
				<Text c="dimmed">正在为你恢复上次的工作环境…</Text>
			</Center>
		)
	}

	return <HomeIntro lastRoute={lastRoute} />
}

type LastRouteMeta = { label: string; description: string; to: string } | null

function getLastRouteMeta(lastRoute: string | null): LastRouteMeta {
	if (!lastRoute) return null
	if (lastRoute.startsWith('/plugins/')) {
		const raw = lastRoute.replace('/plugins/', '')
		try {
			const decoded = decodeURIComponent(raw)
			return {
				label: `继续查看「${decoded}」`,
				description: '快速返回刚才的插件详情',
				to: lastRoute,
			}
		} catch {
			return {
				label: '继续查看插件',
				description: '快速返回刚才的插件详情',
				to: lastRoute,
			}
		}
	}
	const map: Record<string, LastRouteMeta> = {
		'/plugins': {
			label: '返回插件工作台',
			description: '回到分组面板与运行状态',
			to: '/plugins',
		},
		'/packages': {
			label: '回到包管理',
			description: '继续管理依赖与版本',
			to: '/packages',
		},
		'/logs': {
			label: '回到实时日志',
			description: '接着排查最新输出',
			to: '/logs',
		},
	}
	return map[lastRoute] ?? null
}

function HomeIntro({ lastRoute }: { lastRoute: string | null }) {
	const scheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const pattern = getPatternStyle(scheme === 'dark' ? 'dark' : 'light')
	const lastMeta = getLastRouteMeta(lastRoute)
	const quickActions = [
		lastMeta && {
			title: '继续上次工作',
			description: lastMeta.label,
			to: lastMeta.to,
			icon: <IconClockPlay size={20} stroke={1.6} />,
		},
		{
			title: '浏览插件',
			description: '打开分组与运行状态面板',
			to: '/plugins',
			icon: <IconPlugConnected size={20} stroke={1.6} />,
		},
		{
			title: '查看实时日志',
			description: '即时洞察最新输出',
			to: '/logs',
			icon: <IconHistory size={20} stroke={1.6} />,
		},
	].filter(Boolean) as Array<{
		title: string
		description: string
		to: string
		icon: ReactNode
	}>

	const heroBorder = scheme === 'dark' ? 'rgba(148,163,184,0.25)' : 'rgba(15,23,42,0.08)'
	const heroShadow =
		scheme === 'dark' ? '0 30px 80px rgba(2,6,23,0.85)' : '0 20px 60px rgba(15, 23, 42, 0.08)'
	const schemeMode = scheme === 'dark' ? 'dark' : 'light'

	return (
		<Stack gap="lg" p="lg" style={{ height: '100%', minHeight: 0 }}>
			<Paper
				radius="xl"
				withBorder
				style={{
					borderRadius: 32,
					padding: 'var(--mantine-spacing-xl)',
					boxShadow: heroShadow,
					border: `1px solid ${heroBorder}`,
					backgroundColor: pattern.backgroundColor,
					backgroundImage: pattern.backgroundImage,
					backgroundSize: pattern.backgroundSize,
					backgroundPosition: pattern.backgroundPosition,
				}}
			>
				<Stack gap="md" maw={720}>
					<Text size="sm" c="dimmed" tt="uppercase" fw={600} letterSpacing={0.6}>
						欢迎回来
					</Text>
					<Title order={2} fw={700}>
						继续构建你的插件宇宙
					</Title>
					<Text c="dimmed">
						Pluxel 控制台会记住你的工作位置。以下入口可帮助你迅速恢复节奏、跳转到常用工作区。
					</Text>
					<Group gap="sm" mt="xs">
						<Button component={RouterLinkAdapter} to="/plugins">
							打开插件工作台
						</Button>
						<Button component={RouterLinkAdapter} to="/packages" variant="light">
							前往包管理
						</Button>
					</Group>
				</Stack>
				<Group gap="sm" mt="xl" align="stretch">
					{quickActions.map((action) => (
						<Paper
							key={action.title}
							withBorder
							radius="lg"
							p="md"
							style={{
								flex: '1 1 220px',
								display: 'flex',
								flexDirection: 'column',
								gap: 12,
								backgroundColor:
									scheme === 'dark' ? 'rgba(2,6,23,0.85)' : 'rgba(255,255,255,0.92)',
								borderColor: scheme === 'dark' ? 'rgba(148,163,184,0.2)' : undefined,
							}}
						>
							<Group justify="space-between" align="flex-start">
								<div>
									<Text fw={600}>{action.title}</Text>
									<Text size="sm" c={scheme === 'dark' ? 'gray.4' : 'dimmed'}>
										{action.description}
									</Text>
								</div>
								<Box
									style={{
										width: 32,
										height: 32,
										borderRadius: '50%',
										background:
											scheme === 'dark'
												? 'rgba(99,102,241,0.25)'
												: 'rgba(99,102,241,0.12)',
										display: 'flex',
										alignItems: 'center',
										justifyContent: 'center',
									}}
								>
									{action.icon}
								</Box>
							</Group>
							<Button
								component={RouterLinkAdapter}
								to={action.to}
								variant="light"
								size="xs"
								radius="md"
								mt="auto"
							>
								立刻进入
							</Button>
						</Paper>
					))}
				</Group>
			</Paper>

			<Grid gutter="lg">
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="插件工作台"
						description="以分组和搜索快速定位插件，并实时查看运行状态。"
						icon={<IconPlugConnected size={24} stroke={1.6} />}
						to="/plugins"
						scheme={schemeMode}
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="包管理"
						description="管理依赖、查看版本和同步安装状态。"
						icon={<IconPackages size={24} stroke={1.6} />}
						to="/packages"
						scheme={schemeMode}
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="实时日志"
						description="监控最新日志事件，把脉系统健康度。"
						icon={<IconHistory size={24} stroke={1.6} />}
						to="/logs"
						scheme={schemeMode}
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="快捷键提示"
						description="记住 / 或 Ctrl/⌘ + F 可随时唤起插件搜索。"
						icon={<IconKeyboard size={24} stroke={1.6} />}
						to="/plugins"
						scheme={schemeMode}
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="快照与构建"
						description="在顶部工具栏可快速触发快照构建，保存当前状态。"
						icon={<IconBolt size={24} stroke={1.6} />}
						to="/plugins"
						scheme={schemeMode}
					/>
				</Grid.Col>
			</Grid>
		</Stack>
	)
}

function HomeCard({
	title,
	description,
	to,
	icon,
	scheme,
}: {
	title: string
	description: string
	to: string
	icon: React.ReactNode
	scheme: 'light' | 'dark'
}) {
	const isDark = scheme === 'dark'
	return (
		<Button
			component={RouterLinkAdapter}
			to={to}
			variant="default"
			radius="lg"
			style={{
				width: '100%',
				height: '100%',
				display: 'flex',
				alignItems: 'flex-start',
				justifyContent: 'space-between',
				flexDirection: 'column',
				textAlign: 'left',
				padding: 'var(--mantine-spacing-lg)',
				backgroundColor: isDark ? 'rgba(2,6,23,0.85)' : 'rgba(255,255,255,0.92)',
				border: isDark ? '1px solid rgba(148,163,184,0.25)' : '1px solid rgba(15,23,42,0.08)',
				color: isDark ? 'var(--mantine-color-gray-0)' : undefined,
			}}
		>
			<div>
				<Title order={4}>{title}</Title>
				<Text c={isDark ? 'gray.4' : 'dimmed'} size="sm" mt={4}>
					{description}
				</Text>
			</div>
			<Group gap={8} align="center">
				{icon}
				<Text size="sm" fw={600}>
					进入 →
				</Text>
			</Group>
		</Button>
	)
}

const rootRoute = createRootRoute({
	component: RootAppLayout,
})

const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: HomeRouteComponent,
})

const logsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'logs',
	component: () => <LiveLog />,
})

const packagesRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'packages',
	component: PackagesRouteComponent,
})

const pluginsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: 'plugins',
	component: PluginsRouteComponent,
})

const pluginsIndexRoute = createRoute({
	getParentRoute: () => pluginsRoute,
	path: '/',
	component: PluginsPlaceholder,
})

const pluginDetailRoute = createRoute({
	getParentRoute: () => pluginsRoute,
	path: '$name',
	component: PluginDetailRouteComponent,
})

const routeTree = rootRoute.addChildren([
	indexRoute,
	logsRoute,
	packagesRoute,
	pluginsRoute.addChildren([pluginsIndexRoute, pluginDetailRoute]),
])

export interface AppProps {
	history?: RouterHistory
}

export function createAppRouter(options: { history?: RouterHistory } = {}) {
	const history =
		options.history ??
		(typeof window !== 'undefined' ? createBrowserHistory() : createMemoryHistory())
	return createRouter({
		routeTree,
		history,
		defaultPreload: 'intent',
	})
}

const _routerForTypes = createAppRouter()

declare module '@tanstack/react-router' {
	interface Register {
		router: typeof _routerForTypes
	}
}

export function App({ history }: AppProps = {}) {
	const [router] = useState(() => createAppRouter({ history }))
	return <RouterProvider router={router} />
}
