import { ColorSchemeScript } from '@mantine/core'
import { reactRenderer } from '@hono/react-renderer'
import { App, prepareReactRender } from '@pluxel/components'
import { Hono } from 'hono'
import { createMemoryHistory } from '@tanstack/react-router'

import type { AppEnv } from '../services/hono/env'
import { resolveAssets } from './assets'
import type { RenderHandler } from './types'

const assets = resolveAssets(false)

export function createDevRenderer(): RenderHandler {
	const ssrApp = new Hono<AppEnv>()

	const renderMiddleware = reactRenderer(async ({ c }) => {
		const url = new URL(c.req.url)
		const history = createMemoryHistory({
			initialEntries: [`${url.pathname}${url.search}`],
		})
		const shell = <App history={history} />

		const { cacheSnapshot } = await prepareReactRender(shell)

		return (
			<html lang="zh">
				<head>
					<meta charSet="utf-8" />
					<meta name="viewport" content="width=device-width,initial-scale=1" />
					<title>My App</title>
					<ColorSchemeScript />
					{assets.css.map((href) => (
						<link key={href} rel="stylesheet" href={href} />
					))}
					{assets.preload.map((href) => (
						<link key={href} rel="modulepreload" href={href} />
					))}
					<script type="module" src={assets.js} />
				</head>
				<body>
					<div id="root">{shell}</div>
					{cacheSnapshot && (
						<script
							id="__GQTY_CACHE__"
							type="application/json"
							suppressHydrationWarning
							dangerouslySetInnerHTML={{ __html: cacheSnapshot }}
						/>
					)}
				</body>
			</html>
		)
	})

	ssrApp.use('*', (c, next) => renderMiddleware(c, next))
	ssrApp.get('*', (c) => c.render(<App />))

	return (c) => ssrApp.fetch(c.req.raw, c.env, c.executionCtx)
}
