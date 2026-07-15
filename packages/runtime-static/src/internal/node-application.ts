import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve as resolvePath } from 'node:path'
import { Readable } from 'node:stream'
import type { PluginConstructor } from '@pluxel/core'
import { startStaticRuntimeApplication } from './application'
import type { StaticRuntimeWorkbenchInstaller } from './host'
import type {
	StaticRuntime,
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeDeployment,
	StaticRuntimeEnvironment,
} from '../types'

export type StaticNodeApplication = StaticRuntime & {
	readonly address: { host: string; port: number }
}

export async function runStaticNodeApplication<
	TBindings extends StaticRuntimeBindings = StaticRuntimeBindings,
>(
	application: StaticRuntimeApplication<readonly PluginConstructor[], TBindings>,
	options: {
		env?: StaticRuntimeEnvironment
		bindings?: TBindings
		deployment: StaticRuntimeDeployment
		installWorkbench?: StaticRuntimeWorkbenchInstaller
	},
): Promise<StaticNodeApplication> {
	const env = options.env ?? readProcessEnvironment()
	const runtime = await startStaticRuntimeApplication(application, {
		startup: {
			mode: 'production',
			env,
			bindings: options.bindings ?? ({} as TBindings),
			deployment: options.deployment,
		},
		deployment: {
			root: options.deployment.root,
			workbenchIncluded: options.deployment.variant === 'workbench',
			...(options.deployment.variant === 'workbench'
				? {
						publicDir: `${options.deployment.root}/workbench/public`,
						workbenchDir: `${options.deployment.root}/workbench`,
					}
				: {}),
		},
		installWorkbench: options.installWorkbench,
	})
	const host = env.PLUXEL_HOST_BIND?.trim() || '127.0.0.1'
	const port = parsePort(env.PLUXEL_HOST_PORT, 3000)
	const server = createServer((request, response) => {
		void dispatch(runtime, request, response, {
			applicationPublicDir: `${options.deployment.root}/public`,
			serveApplicationPublic:
				options.deployment.variant === 'headless' || !runtime.ctx.workbench.enabled,
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

async function dispatch(
	runtime: StaticRuntime,
	request: IncomingMessage,
	response: ServerResponse,
	options: { applicationPublicDir: string; serveApplicationPublic: boolean },
): Promise<void> {
	try {
		const input = toRequest(request)
		const result = await runtime.fetch(input)
		const applicationAsset =
			result.status === 404 && options.serveApplicationPublic
				? await resolveApplicationAsset(input, options.applicationPublicDir)
				: null
		await writeResponse(response, applicationAsset ?? result)
	} catch (error) {
		response.statusCode = 500
		response.end(error instanceof Error ? error.message : String(error))
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

function toRequest(request: IncomingMessage): Request {
	const host = request.headers.host ?? 'localhost'
	const url = new URL(request.url ?? '/', `http://${host}`)
	const method = (request.method ?? 'GET').toUpperCase()
	const headers = new Headers()
	for (const [key, value] of Object.entries(request.headers)) {
		if (Array.isArray(value)) for (const item of value) headers.append(key, item)
		else if (value !== undefined) headers.set(key, value)
	}
	const body = method === 'GET' || method === 'HEAD' ? undefined : Readable.toWeb(request)
	return new Request(url, {
		method,
		headers,
		body: body as BodyInit | undefined,
		duplex: body ? ('half' as never) : undefined,
	})
}

async function writeResponse(response: ServerResponse, result: Response): Promise<void> {
	response.statusCode = result.status
	for (const [key, value] of result.headers) response.setHeader(key, value)
	if (!result.body) {
		response.end()
		return
	}
	Readable.fromWeb(result.body as never).pipe(response)
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
