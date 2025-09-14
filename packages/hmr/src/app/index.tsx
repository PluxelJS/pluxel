// App.tsx（关键改动标注了 ✅）
import { ModalsProvider } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import { Layout, type NavItem } from '@pluxel/components'
import { Redirect, Route, Switch, useLocation } from 'wouter'
import { Header } from './Header'
import { LiveLog } from './log_viewer/LiveLog'
import { PluginsLayout } from './plugins/PluginsLayout'
import { WouterLinkAdapter } from './WouterLinkAdapter'

const navItems: NavItem[] = [
	{ label: '首页', href: '/', exact: true },
	{ label: '日志', href: '/logs' },
	{ label: '插件', href: '/plugins' }, // 会对 /plugins/:name 前缀激活
]

export function App() {
	const [location] = useLocation()

	return (
		<Layout
			header={({ toggle }) => <Header onMenu={toggle} />}
			navItems={navItems}
			LinkComponent={WouterLinkAdapter}
			currentPath={location}
			footerHeight={0}
		>
			<ModalsProvider>
				<Notifications position="top-center" />
				<Switch>
					<Route path="/" component={() => <Redirect to="/plugins" />} />

					<Route path="/logs">{() => <LiveLog />}</Route>
					<Route path="/plugins/:name">{() => <PluginsLayout />}</Route>
					<Route path="/plugins">{() => <PluginsLayout />}</Route>

					<Route>404 – 页面未找到</Route>
				</Switch>
			</ModalsProvider>
		</Layout>
	)
}
