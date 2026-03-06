import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHmrHost } from '@pluxel/hmr/host'
import type { HmrWorkspaceSnapshot } from '@pluxel/hmr/snapshot'
import { createFixture } from 'fs-fixture'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'
import { createUiPublicStaticMiddleware } from '../../src/server/ui-public'

type Middleware = (
	req: IncomingMessage,
	res: ServerResponse,
	next: (err?: unknown) => void,
) => unknown

function mount(base: string, handler: Middleware) {
	return (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
		const rawUrl = typeof req?.url === 'string' ? req.url : '/'
		const { pathname } = new URL(rawUrl, 'http://localhost')
		if (pathname !== base && !pathname.startsWith(`${base}/`)) return next()

		const originalUrl = req.url
		req.url = rawUrl.slice(base.length) || '/'
		handler(req, res, (err) => {
			req.url = originalUrl
			if (err) return next(err)
			return next()
		})
	}
}

function htmlFallback() {
	return (_req: IncomingMessage, res: ServerResponse) => {
		res.statusCode = 200
		res.setHeader('Content-Type', 'text/html; charset=utf-8')
		res.end('<!doctype html><html><body>fallback</body></html>')
	}
}

async function startHttpServer(middlewares: Middleware[]) {
	const server = createServer((req, res) => {
		let i = 0
		const next = (err?: unknown) => {
			if (err) {
				res.statusCode = 500
				res.end(String(err))
				return
			}
			const mw = middlewares[i++]
			if (!mw) {
				res.statusCode = 404
				res.end('not found')
				return
			}
			mw(req, res, next)
		}
		next()
	})

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
	const addr = server.address()
	if (!addr || typeof addr === 'string') throw new Error('server address unavailable')

	return {
		baseUrl: `http://127.0.0.1:${addr.port}`,
		close: async () =>
			new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
	}
}

describe('HMR UI smoke', () => {
	it('serves built UI assets from /dist/public', async () => {
		await using fixture = await createFixture({
			'dist/public/assets/hello.js': 'console.log("hello")\n',
		})

		const publicDir = resolve(fixture.path, 'dist/public')
		const ui = createUiPublicStaticMiddleware(publicDir)
		expect(ui).toBeTypeOf('function')

		const middleware = ui as NonNullable<typeof ui>
		const { baseUrl, close } = await startHttpServer([
			mount('/dist/public', middleware),
			htmlFallback(),
		])
		try {
			const res1 = await fetch(`${baseUrl}/dist/public/assets/hello.js`)
			expect(res1.status).toBe(200)
			expect(res1.headers.get('content-type')).toContain('application/javascript')

			// Regression: missing assets must not fall through to an HTML SPA fallback
			// (which triggers strict-MIME errors in browsers).
			const res3 = await fetch(`${baseUrl}/dist/public/assets/missing.css`)
			expect(res3.status).toBe(404)
			expect(res3.headers.get('content-type')).toContain('text/plain')
		} finally {
			await close()
		}
	})

	it('exposes /__pluxel/hmr/graphql (used by the UI)', async () => {
		await using fixture = await createFixture({
			'pnpm-workspace.yaml': ['packages:', '  - packages/*', ''].join('\n'),
			// HMR may persist runtime config under `data/`; pre-create so fixture cleanup is stable.
			'data/hmr/config.dev.json': '{}\n',
			'packages/a/package.json': JSON.stringify(
				{
					name: 'pluxel-plugin-a',
					version: '0.0.0',
					type: 'module',
					exports: { '.': { '@pluxel/hmr': './src/index.ts', default: './dist/index.mjs' } },
				},
				null,
				2,
			),
			'packages/a/src/index.ts': 'export const plugins = []\n',
			'packages/a/dist/index.mjs': 'export const plugins = []\n',
		})

		const prevCwd = process.cwd()
		try {
			const snapshot: HmrWorkspaceSnapshot = {
				activeProfile: 'dev',
				roots: ['packages/a'],
				enabled: ['pluxel-plugin-a'],
				builtinPackages: [],
				enabledEntries: ['packages/a/src/index.ts'],
				includedEntries: [],
				watchRoots: ['packages/a'],
				includeGlobs: [],
				excludeGlobs: [],
			}
			const host = await createHmrHost({
				root: fixture.path,
				logging: false,
				workspaceSnapshot: snapshot,
			})

			const res = await host.ctx.honoService.fetch(
				new Request('http://local/__pluxel/hmr/graphql', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ query: '{ _empty }' }),
				}),
			)

			expect(res.status).toBe(200)
			const json = (await res.json()) as { data?: { _empty?: string } }
			expect(json.data?._empty).toBe('ok')
			await host.ctx.effects.dispose()
		} finally {
			process.chdir(prevCwd)
		}
	}, 15_000)
})
