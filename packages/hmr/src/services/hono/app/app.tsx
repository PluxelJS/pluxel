import { Link, Redirect, Route, Switch } from 'wouter'
import { Home } from '../form'

export default function App() {
	return (
		<div>
			<nav>
				<Link href="/">首页</Link> | <Link href="/about">关于</Link> |{' '}
				<Link href="/login">登录</Link>
			</nav>
			<Switch>
				<Route path="/" component={() => <Home />} />
				<Route path="/about" component={() => <h1>About Us</h1>} />
				<Route path="/login" component={() => <h1>Login Page</h1>} />
				{/* 如果未登录就重定向到 /login */}
				<Route path="/profile">
					{() => (isLoggedIn() ? <Profile /> : <Redirect to="/login" />)}
				</Route>
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
