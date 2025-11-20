import {
	Badge,
	Button,
	Center,
	Grid,
	Group,
	MantineProvider,
	Paper,
	Stack,
	Text,
	Title,
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
import { useEffect, useState } from 'react'
import { Layout, type NavItem } from '../components'
import { IconHome2, IconHistory, IconPackages, IconPuzzle } from '@tabler/icons-react'
import { ClientOnly } from './ClientOnly'
import { Header } from './Header'
import { LiveLog } from './log_viewer/LiveLog'
import { PackageManagerPage } from './packages/PackageManagerPage'
import { Plugin } from './plugins/Plugin'
import { PluginsLayout } from './plugins/PluginsLayout'
import { RouterLinkAdapter } from './RouterLinkAdapter'
import { HOME_MANUAL_KEY, LAST_ROUTE_KEY } from './constants'

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

	useEffect(() => {
		if (typeof window === 'undefined') return
		const manual = window.sessionStorage.getItem(HOME_MANUAL_KEY)
		if (manual) {
			window.sessionStorage.removeItem(HOME_MANUAL_KEY)
			setShowIntro(true)
			return
		}
		const last = window.localStorage.getItem(LAST_ROUTE_KEY)
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

	return <HomeIntro />
}

function HomeIntro() {
	return (
		<Stack gap="lg" p="lg" style={{ height: '100%', minHeight: 0 }}>
			<Stack gap="xs">
				<Text size="sm" c="dimmed" tt="uppercase" fw={600} letterSpacing={0.6}>
					欢迎回来
				</Text>
				<Title order={2} fw={700}>
					继续构建你的插件宇宙
				</Title>
				<Text c="dimmed">
					Pluxel 控制台会记住你的工作位置。若需要重新开始，可从以下入口快速跳转。
				</Text>
				<Group gap="sm" mt="sm">
					<Button component={RouterLinkAdapter} to="/plugins">
						打开插件工作台
					</Button>
					<Button component={RouterLinkAdapter} to="/packages" variant="light">
						前往包管理
					</Button>
				</Group>
			</Stack>

			<Grid gutter="lg">
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="插件工作台"
						description="以分组和搜索快速定位插件，并实时查看运行状态。"
						to="/plugins"
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="包管理"
						description="管理依赖、查看版本和同步安装状态。"
						to="/packages"
					/>
				</Grid.Col>
				<Grid.Col span={{ base: 12, md: 4 }}>
					<HomeCard
						title="实时日志"
						description="监控最新日志事件，把脉系统健康度。"
						to="/logs"
					/>
				</Grid.Col>
			</Grid>
		</Stack>
	)
}

function HomeCard({ title, description, to }: { title: string; description: string; to: string }) {
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
			}}
		>
			<div>
				<Title order={4}>{title}</Title>
				<Text c="dimmed" size="sm" mt={4}>
					{description}
				</Text>
			</div>
			<Text size="sm" fw={600}>
				进入 →
			</Text>
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
