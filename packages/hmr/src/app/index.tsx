// App.tsx （使用 Wouter 演示）
import { Route, Switch, Redirect, Link as WLink } from 'wouter'
import { AppLayout, type NavItem } from '@pluxel/components/src/app/AppLayout'
import { Plugin as TestPlugin } from './Plugin'
import { TestPath } from '@pluxel/components/src/app/TestPath'
import { Home } from '@pluxel/components/src/app/form'
import { ExamplePage } from '@pluxel/components/src/app/Plugin/Example'

const navItems: NavItem[] = [
	{ label: '首页', href: '/' },
	{ label: '关于', href: '/about' },
	{ label: '登录', href: '/login' },
	{ label: '表单页', href: '/form' },
	{ label: '测试', href: '/test/foo' },
	{ label: '插件', href: '/plugins/bar' },
	{ label: '用户中心', href: '/profile' },
]

function isLoggedIn() {
	return false /* 替成真逻辑 */
}

export function App() {
	return (
		<AppLayout navItems={navItems} LinkComponent={WLink}>
			<Switch>
				<Route path="/" component={() => <h1>Welcome Home</h1>} />
				<Route path="/about" component={() => <ExamplePage />} />
				<Route path="/login" component={() => <h1>Login Page</h1>} />
				<Route path="/profile">
					{() => (isLoggedIn() ? <h1>用户中心</h1> : <Redirect to="/login" />)}
				</Route>
				<Route path="/form" component={Home} />
				<Route path="/test/:name" component={TestPath} />
				<Route path="/plugins/:name" component={TestPlugin} />
				<Route>404 – 页面未找到</Route>
			</Switch>
		</AppLayout>
	)
}
