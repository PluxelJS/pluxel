// App.tsx（关键改动标注了 ✅）
import React from 'react'
import { Route, Switch, Redirect, Link, useLocation } from 'wouter'
import type { NavItem } from '@pluxel/components'
import { Layout, TestPath, ExamplePage } from '@pluxel/components'
import { PluginsLayout } from './plugins/PluginsLayout'
import { Notifications } from '@mantine/notifications'
import { ModalsProvider } from '@mantine/modals'
import { Button } from '@mantine/core'
import { LogSnapshot } from './log_viewer/LogSnapshot'
import { Demo } from './notification'
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
	const [location] = useLocation() // ✅ 拿到当前路径

	return (
		<Layout
			header={({ toggle }) => <MyHeader onMenu={toggle} />}
			navItems={navItems}
			LinkComponent={WouterLinkAdapter} // ✅ 用适配器，彻底消除 TS 报错
			currentPath={location} // ✅ 把当前路径交给 Layout，激活态总是正确
			footerHeight={0}
		>
			<ModalsProvider>
				<Notifications position="top-center" />
				<Switch>
					<Route path="/" component={() => <Demo />} />
					<Route path="/about" component={() => <ExamplePage />} />
					<Route path="/test/:name" component={TestPath} />
					<Route path="/profile">
						{() =>
							isLoggedIn() ? <h1>用户中心</h1> : <Redirect to="/login" />
						}
					</Route>

					<Route path="/logs">{() => <LogSnapshot />}</Route>
					<Route path="/plugins/:name">{() => <PluginsLayout />}</Route>
					<Route path="/plugins">{() => <PluginsLayout />}</Route>

					<Route>404 – 页面未找到</Route>
				</Switch>
			</ModalsProvider>
		</Layout>
	)
}
