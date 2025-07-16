import { Link, Redirect, Route, Switch } from 'wouter'
import { TestPath } from './TestPath'
import { Home } from './form'
import { Plugin } from './plugin'

export default function App() {
	return (
		<div>
			<nav>
				<Link href="/">首页</Link> | <Link href="/about">关于</Link> |{' '}
				<Link href="/login">登录</Link>
			</nav>
			<Switch>
				<Route path="/" component={() => <h1>Welcome Home</h1>} />
				<Route path="/about" component={() => <h1>About Us</h1>} />
				<Route path="/login" component={() => <h1>Login Page</h1>} />
				{/* 如果未登录就重定向到 /login */}
				<Route path="/profile">
					{() => (isLoggedIn() ? <Profile /> : <Redirect to="/login" />)}
				</Route>{' '}
				<Route path="/form">{() => <Home />}</Route>
				<Route path="/test/:name" component={TestPath} />
				<Route path="/plugin/:name">{() => <Plugin />}</Route>
				{/* 兜底 404 */}
				<Route>404 – 页面未找到</Route>
			</Switch>
		</div>
	)
}

function isLoggedIn(): boolean {
	// 伪逻辑，根据实际 auth 情况替换
	return false
}

function Profile() {
	return <h1>用户中心</h1>
}
