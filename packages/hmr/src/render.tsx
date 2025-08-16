// render.tsx
import { reactRenderer } from '@hono/react-renderer'
import { ColorSchemeScript, MantineProvider } from '@mantine/core'
import { HydrationBoundary, QueryClientProvider } from '@tanstack/react-query'
import { Router } from 'wouter'

const PUBLIC_BASE =
	process.env.CLIENT_DIST ?? '/node_modules/@pluxel/hmr/public'
const PROD = import.meta.env.PROD

import rawManifest from '../public/.vite/manifest.json' assert { type: 'json' }

type MfEntry = {
	file: string
	css?: string[]
	imports?: string[]
	isEntry?: boolean
}
type Manifest = Record<string, MfEntry>

// —— 构建一次、用整局 —— //
const ASSETS = (() => {
	if (!PROD)
		return {
			js: '/src/client.tsx',
			css: [] as string[],
			preload: [] as string[],
		}

	const mf = rawManifest as Manifest
	const pickEntry = (entry = 'src/client.tsx') =>
		entry in mf
			? entry
			: (Object.keys(mf).find((k) => mf[k]?.isEntry) ?? Object.keys(mf)[0])

	const key = pickEntry('src/client.tsx')
	const root = mf[key]
	if (!root) throw new Error(`manifest missing entry: ${key}`)

	const files: string[] = [] // 保序
	const cssSet = new Set<string>()
	const seen = new Set<string>()

	const push = (p?: string) => {
		if (p && !seen.has(p)) {
			seen.add(p)
			files.push(p)
		}
	}
	const visit = (k: string) => {
		const e = mf[k]
		if (!e) return
		push(e.file)
		e.css?.forEach((c) => cssSet.add(c))
		e.imports?.forEach(visit)
	}

	visit(key)

	const toUrl = (p: string) => `${PUBLIC_BASE}/${p}`
	const [main, ...rest] = files
	return {
		js: toUrl(main!),
		css: Array.from(cssSet).map(toUrl),
		preload: rest.map(toUrl),
	}
})()

export const renderMiddleware = reactRenderer(({ c, children }) => {
	const { qc, dehydratedState } = c.var

	return (
		<html lang="zh">
			<head>
				<meta charSet="utf-8" />
				<meta name="viewport" content="width=device-width,initial-scale=1" />
				<title>My App</title>
				<ColorSchemeScript />
				{ASSETS.css.map((href) => (
					<link key={href} rel="stylesheet" href={href} />
				))}
				{ASSETS.preload.map((href) => (
					<link key={href} rel="modulepreload" href={href} />
				))}
				<script type="module" src={ASSETS.js} />
			</head>
			<body>
				<div id="root">
					<QueryClientProvider client={qc}>
						<HydrationBoundary state={dehydratedState}>
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

				{dehydratedState && (
					<script
						id="__REACT_QUERY_STATE__"
						type="application/json"
						dangerouslySetInnerHTML={{
							__html: JSON.stringify(dehydratedState),
						}}
					/>
				)}
			</body>
		</html>
	)
})
