import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve as resolvePath } from 'node:path'
import { Readable } from 'node:stream'
import type { PluginConstructor } from '@pluxel/core'
import type { ProductDescriptor } from '@pluxel/runtime/product'
import { runStaticFetchApplication, type StaticFetchApplicationOptions } from './fetch-application'
import { createNodeFetchRequest, writeNodeFetchResponse } from './node-http'
import type { StaticRuntimeWorkbenchInstaller } from './host'
import type { StaticRuntime, StaticRuntimeApplication, StaticRuntimeBindings } from '../types'

export type StaticNodeApplication = StaticRuntime & {
	readonly address: { host: string; port: number }
}

export async function runStaticNodeApplication<
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
>(
	application: StaticRuntimeApplication<readonly PluginConstructor[], TBindings>,
	options: StaticFetchApplicationOptions<TBindings> & {
		installWorkbench?: StaticRuntimeWorkbenchInstaller
		product?: ProductDescriptor | null
	},
): Promise<StaticNodeApplication> {
	const env = options.env ?? readProcessEnvironment()
	const runtime = await runStaticFetchApplication(application, { ...options, env })
	const host = env.PLUXEL_HOST_BIND?.trim() || '127.0.0.1'
	const port = parsePort(env.PLUXEL_HOST_PORT, 3000)
	const server = createServer((request, response) => {
		void dispatch(runtime, request, response, {
			applicationPublicDir: `${options.deployment.root}/public`,
			serveApplicationPublic:
				options.deployment.variant === 'headless' ||
				!workbenchOwnsRootNavigation(runtime.ctx.config.workbench),
		})
	})
	try {
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject)
			server.listen(port, host, () => {
				server.off('error', reject)
				resolve()
			})
		})
	} catch (error) {
		await runtime.stop().catch((): undefined => undefined)
		throw error
	}
	const address = server.address()
	const actualPort = typeof address === 'object' && address ? address.port : port
	let stopPromise: Promise<void> | undefined
	const stop = () => {
		stopPromise ??= (async () => {
			process.off('SIGINT', onSignal)
			process.off('SIGTERM', onSignal)
			let closeError: unknown
			try {
				await new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) reject(error)
						else resolve()
					})
				})
			} catch (error) {
				closeError = error
			}
			try {
				await runtime.stop()
			} catch (runtimeError) {
				if (closeError) {
					const shutdownError = new Error(
						'[runtime-static] Node listener and runtime shutdown both failed',
						{
							cause: runtimeError,
						},
					)
					Object.defineProperty(shutdownError, 'listenerCloseError', { value: closeError })
					throw shutdownError
				}
				throw runtimeError
			}
			if (closeError) throw closeError
		})()
		return stopPromise
	}
	const onSignal = () => {
		void stop().then(
			() => process.exit(0),
			() => process.exit(1),
		)
	}
	process.once('SIGINT', onSignal)
	process.once('SIGTERM', onSignal)

	return {
		...runtime,
		address: { host, port: actualPort },
		stop,
	}
}

function workbenchOwnsRootNavigation(config: StaticRuntime['ctx']['config']['workbench']): boolean {
	return config !== false && config?.enabled === true && (config.uiBasePath ?? '/') === '/'
}

async function dispatch(
	runtime: StaticRuntime,
	request: IncomingMessage,
	response: ServerResponse,
	options: { applicationPublicDir: string; serveApplicationPublic: boolean },
): Promise<void> {
	const exchange = createNodeFetchRequest(
		request,
		response,
		`http://${request.headers.host ?? 'localhost'}`,
	)
	try {
		const input = exchange.request
		const result = await runtime.fetch(input)
		const applicationAsset =
			result.status === 404 && options.serveApplicationPublic
				? await resolveApplicationAsset(input, options.applicationPublicDir)
				: null
		await writeNodeFetchResponse(response, applicationAsset ?? result, exchange.signal)
	} catch (error) {
		if (exchange.signal.aborted || response.destroyed) return
		if (response.headersSent)
			response.destroy(error instanceof Error ? error : new Error(String(error)))
		else {
			response.statusCode = 500
			response.end(error instanceof Error ? error.message : String(error))
		}
	} finally {
		exchange.dispose()
	}
}

async function resolveApplicationAsset(
	request: Request,
	publicDir: string,
): Promise<Response | null> {
	if (request.method !== 'GET' && request.method !== 'HEAD') return null
	let pathname: string
	try {
		pathname = decodeURIComponent(new URL(request.url).pathname)
	} catch {
		return null
	}
	const relativePath = pathname.replace(/^\/+/, '')
	const direct = relativePath
		? resolvePath(publicDir, relativePath)
		: resolvePath(publicDir, 'index.html')
	const directAsset = await toApplicationAssetResponse(request, publicDir, direct)
	if (directAsset) return directAsset
	if (!request.headers.get('accept')?.toLowerCase().includes('text/html')) return null
	return toApplicationAssetResponse(request, publicDir, resolvePath(publicDir, 'index.html'))
}

async function toApplicationAssetResponse(
	request: Request,
	publicDir: string,
	path: string,
): Promise<Response | null> {
	const relativePath = relative(publicDir, path)
	if (relativePath.startsWith('..') || isAbsolute(relativePath)) return null
	const fileStat = await stat(path).catch((): null => null)
	if (!fileStat?.isFile()) return null
	const headers = new Headers({
		'content-length': String(fileStat.size),
		'content-type': applicationContentType(path),
	})
	if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
	return new Response(Readable.toWeb(createReadStream(path)) as BodyInit, { status: 200, headers })
}

function applicationContentType(path: string): string {
	switch (extname(path).toLowerCase()) {
		case '.html':
			return 'text/html; charset=utf-8'
		case '.css':
			return 'text/css; charset=utf-8'
		case '.js':
		case '.mjs':
			return 'application/javascript; charset=utf-8'
		case '.json':
			return 'application/json; charset=utf-8'
		case '.svg':
			return 'image/svg+xml'
		case '.png':
			return 'image/png'
		case '.jpg':
		case '.jpeg':
			return 'image/jpeg'
		case '.webp':
			return 'image/webp'
		case '.woff2':
			return 'font/woff2'
		default:
			return 'application/octet-stream'
	}
}

function readProcessEnvironment(): StaticRuntimeEnvironment {
	return process.env
}

function parsePort(value: string | undefined, fallback: number): number {
	if (value === undefined || value.trim() === '') return fallback
	const port = Number(value)
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`[runtime-static] Invalid PLUXEL_HOST_PORT: ${value}`)
	}
	return port
}
