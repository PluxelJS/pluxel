import { reactRenderer } from '@hono/react-renderer'
import { ColorSchemeScript, MantineProvider } from '@mantine/core'
// server.ts
import { Hono } from 'hono'
import type React from 'react'
import { Router } from 'wouter'
import App from './app/app'

const app = new Hono()
const Layout = ({ children }) => (
	<html lang="en">
		<head>
			<meta charSet="utf-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1" />
			<title>My App</title>
			{/* 引入外部 CSS */}
			{/* <link rel="stylesheet" href="/node_modules/@mantine/core/styles.css" /> */}
			{/* 可选：配合 @mantine/ssr 收集全局样式 */}
			{/* <ServerStyles server={stylesServer} /> */}
		</head>
		<body>
			<div id="root">{children}</div>
			<script type="module" src="/src/client.tsx" />
		</body>
	</html>
)

app.use(
	'*',
	reactRenderer(({ c, children }) => (
		<Router ssrPath={c.req.path} ssrSearch={c.req.url.split('?')[1] || ''}>
			<MantineProvider withGlobalClasses={false} withCssVariables={false}>
				<ColorSchemeScript /> {/* 只涉及 <head>，不会进入 root */}
				<Layout>{children}</Layout>
			</MantineProvider>
		</Router>
	)),
)

// 2. 所有路由都走渲染
app.get('*', (c) => {
	// 注意：reactRenderer 版本 <redirect> 目前还不会自动转 HTTP 重定向
	// 如果需要，你可以在这里检查 context 并主动 c.redirect()
	return c.render(<App />)
})

export { app }
