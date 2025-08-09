// render.tsx
import { reactRenderer } from '@hono/react-renderer'
import { ColorSchemeScript, MantineProvider } from '@mantine/core'
import { HydrationBoundary, QueryClientProvider } from '@tanstack/react-query'
import { Router } from 'wouter'

export const renderMiddleware = reactRenderer(({ c, children }) => {
	const { qc, dehydratedState } = c.var

	return (
		<html lang="zh">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width,initial-scale=1" />
				<title>My App</title>

				{/* Mantine 样式（在 hydration 前就可用） */}
				<link
					rel="stylesheet"
					href="http://localhost:3000/node_modules/@mantine/core/styles.css"
				/>
				<link
					rel="stylesheet"
					href="http://localhost:3000/node_modules/@mantine/notifications/styles.css"
				/>

				<ColorSchemeScript />
			</head>
			<body>
				<div id="root">
					<QueryClientProvider client={qc}>
						{/* 无论有没有状态，统一渲染 HydrationBoundary，保持两端完全一致 */}
						<HydrationBoundary state={dehydratedState}>
							{/* 关键：MantineProvider 进入 root 内，顺序与客户端一致 */}
							<MantineProvider
								withGlobalClasses={false}
								deduplicateCssVariables={false}
							>
								<Router
									ssrPath={c.req.path}
									ssrSearch={c.req.url.split('?')[1] || ''}
								>
									{children}
								</Router>
							</MantineProvider>
						</HydrationBoundary>
					</QueryClientProvider>
				</div>

				{/* 放在 root 外，不参与 hydration 的 JSON 快照 */}
				{dehydratedState && (
					<script
						id="__REACT_QUERY_STATE__"
						type="application/json"
						dangerouslySetInnerHTML={{
							__html: JSON.stringify(dehydratedState),
						}}
					/>
				)}

				<script type="module" src="/src/client.tsx" />
			</body>
		</html>
	)
})
