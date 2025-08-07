// App.tsx
import React, { useState } from 'react'
import { Route, Switch, Redirect } from 'wouter'
import type { NavItem } from '@pluxel/components'
import { Layout, TestPath, ExamplePage } from '@pluxel/components'
import { PluginsLayout } from './plugins/PluginsLayout'
import { LiveLog, LogSnapshot } from './LogViewer'
import { Demo } from './notification'
import { Notifications } from '@mantine/notifications'

const navItems: NavItem[] = [
	{ label: '首页', href: '/' },
	{ label: '关于', href: '/about' },
	{ label: '日志', href: '/logs' },
	{ label: '测试', href: '/test/foo' },
	{ label: '插件', href: '/plugins' },
	{ label: '用户中心', href: '/profile' },
]

function isLoggedIn() {
	return false // 替成真逻辑
}

export function App() {
	const [opened, setOpened] = useState(true)
	return (
		<Layout navItems={navItems} opened={opened}>
			<Notifications position="top-center" />
			<Switch>
				<Route path="/" component={() => <Demo />} />
				<Route path="/about" component={() => <ExamplePage />} />
				<Route path="/test/:name" component={TestPath} />
				<Route path="/profile">
					{() => (isLoggedIn() ? <h1>用户中心</h1> : <Redirect to="/login" />)}
				</Route>

				<Route path="/logs">{() => <LiveLog />}</Route>

				{/* 插件区路由：先精确匹配 /plugins/:name，再兜底 /plugins */}
				<Route path="/plugins/:name">{() => <PluginsLayout />}</Route>
				<Route path="/plugins">{() => <PluginsLayout />}</Route>

				<Route>404 – 页面未找到</Route>
			</Switch>
		</Layout>
	)
}
