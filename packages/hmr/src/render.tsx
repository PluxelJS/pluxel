// render.tsx
import { reactRenderer } from '@hono/react-renderer'
import { ColorSchemeScript, MantineProvider } from '@mantine/core'
import { HydrationBoundary, QueryClientProvider } from '@tanstack/react-query'
import { Router } from 'wouter'

export const renderMiddleware = reactRenderer(({ c, children }) => {
	const { qc, dehydratedState } = c.var

	return (
		<QueryClientProvider client={qc}>
			<Router ssrPath={c.req.path} ssrSearch={c.req.url.split('?')[1] || ''}>
				<MantineProvider withGlobalClasses={false}>
					<ColorSchemeScript />

					<html lang="zh">
						<head>
							<meta charSet="utf-8" />
							<meta
								name="viewport"
								content="width=device-width,initial-scale=1"
							/>
							<title>My App</title>
							<link
								rel="stylesheet"
								href={
									'http://localhost:3000/node_modules/@mantine/core/styles.css'
								}
							/>
							<link
								rel="stylesheet"
								href={
									'http://localhost:3000/node_modules/@mantine/notifications/styles.css'
								}
							/>
						</head>
						<body>
							{/* ① React 只管理这里的 children */}
							<div id="root">
								{dehydratedState ? (
									<HydrationBoundary state={dehydratedState}>
										{children}
									</HydrationBoundary>
								) : (
									children
								)}
							</div>

							{/* ② 把 JSON 脚本插在 root 之外，Hydration 不会管它 */}
							{dehydratedState && (
								<script
									id="__REACT_QUERY_STATE__"
									type="application/json"
									// biome-ignore lint/security/noDangerouslySetInnerHtml: <explanation>
									dangerouslySetInnerHTML={{
										__html: JSON.stringify(dehydratedState),
									}}
								/>
							)}

							{/* ③ 客户端入口 */}
							<script type="module" src="/src/client.tsx" />
						</body>
					</html>
				</MantineProvider>
			</Router>
		</QueryClientProvider>
	)
})
