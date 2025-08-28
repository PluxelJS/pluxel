// App.tsx（关键改动标注了 ✅）

import { Button } from '@mantine/core'
import { ModalsProvider } from '@mantine/modals'
import { Notifications } from '@mantine/notifications'
import type { NavItem } from '@pluxel/components'
import { ExamplePage, Layout, TestPath } from '@pluxel/components'
import React from 'react'
import { Link, Redirect, Route, Switch, useLocation } from 'wouter'
import { LiveLog } from './log_viewer/LiveLog'
import { Demo } from './notification'
import { PluginsLayout } from './plugins/PluginsLayout'
import { WouterLinkAdapter } from './WouterLinkAdapter'

const navItems: NavItem[] = [
	{ label: '首页', href: '/', exact: true },
	{ label: '关于', href: '/about' },
	{ label: '日志', href: '/logs' },
	{ label: '测试', href: '/test/foo' },
	{ label: '插件', href: '/plugins' }, // 会对 /plugins/:name 前缀激活
	{ label: '用户中心', href: '/profile' },
]

function isLoggedIn() {
	return false
}

function MyHeader({ onMenu }: { onMenu: () => void }) {
	return (
		<div
			style={{
				height: '100%',
				display: 'flex',
				alignItems: 'center',
				padding: 16,
			}}
		>
			<Button onClick={onMenu}>☰</Button>
			<b style={{ marginLeft: 8 }}>自定义头部</b>
			<span style={{ marginLeft: 'auto' }}>右侧操作</span>
		</div>
	)
}

export function App() {
	const [location] = useLocation()

	return (
		<Layout
			header={({ toggle }) => <MyHeader onMenu={toggle} />}
			navItems={navItems}
			LinkComponent={WouterLinkAdapter}
			currentPath={location}
			footerHeight={0}
		>
			<ModalsProvider>
				<Notifications position="top-center" />
				<Switch>
					<Route path="/" component={() => <Redirect to="/plugins" />} />
					<Route path="/about" component={() => <ExamplePage />} />
					<Route path="/test/:name" component={TestPath} />
					<Route path="/profile">
						{() => (isLoggedIn() ? <h1>用户中心</h1> : <Redirect to="/login" />)}
					</Route>

					<Route path="/logs">{() => <LiveLog />}</Route>
					<Route path="/plugins/:name">{() => <PluginsLayout />}</Route>
					<Route path="/plugins">{() => <PluginsLayout />}</Route>

					<Route>404 – 页面未找到</Route>
				</Switch>
			</ModalsProvider>
		</Layout>
	)
}
