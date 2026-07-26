import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	collectViteSsrImportFiles,
	createWorkbenchViteClientConfig,
	importViteSsrModule,
	invalidateViteSsrModule,
} from '../../runtime-dev/src/vite.ts'
import { pluxelRuntimeSourceVitePlugins } from '../../rolldown/src/vite/index.ts'
import {
	HMR_PATH_PREVIEW_LIMIT,
	hmrChangedPreviewProps,
	hmrInvalidated,
	hmrPathPreview,
	roundHmrMs,
	type HmrPluginTotals,
	type HmrReportLogProps,
	type HmrUpdatedLogProps,
} from '../../runtime-dev/src/hmr-log.ts'
import { isPluginEnabled, resolveDevWorkbenchClientEntryUrl } from '@pluxel/runtime/internal'
import { installWorkbench } from '@pluxel/runtime/internal/static'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { normalizePath, type Plugin, type PluginOption, type ViteDevServer } from 'vite'

import { reloadStaticRuntime } from './hmr'
import { isStaticRuntimeApplication, resolveStaticRuntimeHostOptions } from './application'
import { toStaticRuntimeDefinition } from './internal/application'
import { createStaticRuntimeHost } from './internal/host'
import type {
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeDefinition,
	StaticRuntimeHost,
	StaticRuntimeHmrReport,
	StaticRuntimeStartupReport,
	StaticRuntimeStartupContext,
} from './types'

const STATIC_RUNTIME_SERVER_KEY = Symbol.for('pluxel.staticRuntimeVitePlugin')
const STATIC_RUNTIME_CACHE_DIR = '.pluxel/vite/static-runtime-v2'

export type StaticRuntimeVitePluginOptions = {
	entry: string
	bindings?: StaticRuntimeBindings | (() => StaticRuntimeBindings | Promise<StaticRuntimeBindings>)
}

export function staticRuntimeVitePlugin(options: StaticRuntimeVitePluginOptions): PluginOption[] {
	const state: {
		server?: ViteDevServer
		entryPath?: string
		configFiles: Set<string>
		application?: StaticRuntimeApplication
		host?: StaticRuntimeHost
	} = {
		configFiles: new Set(),
	}

	const loadApplication = async (
		fresh: boolean,
	): Promise<{ application: StaticRuntimeApplication; configFiles: Set<string> }> => {
		const server = state.server
		if (!server) throw new Error('[runtime-static/vite] Vite server is not configured')
		const entryPath = (state.entryPath ??= resolveRuntimeEntryPath(
			server,
			options.entry,
			'runtime-static',
		))
		const mod = await importViteSsrModule(server, entryPath, { fresh })
		return {
			application: validateStaticRuntimeApplicationModule(mod, entryPath),
			configFiles: collectViteSsrImportFiles(server, entryPath),
		}
	}

	const createHost = async (application: StaticRuntimeApplication): Promise<StaticRuntimeHost> => {
		const server = state.server
		if (!server) throw new Error('[runtime-static/vite] Vite server is not configured')
		const startup: StaticRuntimeStartupContext = {
			mode: 'development',
			env: process.env,
			bindings: await resolveViteBindings(options.bindings),
		}
		const config = await resolveStaticRuntimeHostOptions(application, startup)
		const host = await createStaticRuntimeHost(
			toStaticRuntimeDefinition(application),
			{
				...config,
				http:
					config.workbench !== false && config.workbench?.enabled === true
						? withDevWorkbenchHttpConfig(config.http)
						: config.http,
			},
			{ installWorkbench },
		)
		try {
			const workbenchEnabled = config.workbench !== false && config.workbench?.enabled === true
			const pluginDirs = workbenchEnabled ? resolveStaticRuntimePluginDirs(server, host) : undefined
			await configureStaticRuntimeDevRuntime(server, host, pluginDirs)
			await application.prepare?.({ host, startup })
			return host
		} catch (error) {
			await host.stop().catch((): undefined => undefined)
			throw error
		}
	}

	async function replaceHost(
		application: StaticRuntimeApplication,
	): Promise<StaticRuntimeStartupReport> {
		const previousHost = state.host
		const previousApplication = state.application
		if (previousHost) {
			await previousHost.stop()
			state.host = undefined
		}

		let next: StaticRuntimeHost | undefined
		try {
			next = await createHost(application)
			const startup = await next.start()
			state.host = next
			state.application = application
			return startup
		} catch (error) {
			await next?.stop().catch((): undefined => undefined)
			if (previousHost && previousApplication) {
				try {
					const restored = await createHost(previousApplication)
					await restored.start()
					state.host = restored
					state.application = previousApplication
				} catch (rollbackError) {
					const replacementError = new Error(
						'[runtime-static/vite] host replacement and rollback both failed',
						{
							cause: error,
						},
					)
					Object.defineProperty(replacementError, 'rollbackError', { value: rollbackError })
					throw replacementError
				}
			}
			throw error
		}
	}

	const routePlugin: Plugin = {
		name: 'pluxel:static-runtime',
		apply: 'serve',
		config(config) {
			return {
				...createWorkbenchViteClientConfig(resolveDevWorkbenchClientEntryUrl()),
				...(config.cacheDir === undefined ? { cacheDir: STATIC_RUNTIME_CACHE_DIR } : {}),
			}
		},
		async configureServer(server) {
			const marked = server as ViteDevServer & { [STATIC_RUNTIME_SERVER_KEY]?: true }
			if (marked[STATIC_RUNTIME_SERVER_KEY]) {
				throw new Error('[runtime-static/vite] only one staticRuntimeVitePlugin is allowed')
			}
			marked[STATIC_RUNTIME_SERVER_KEY] = true
			state.server = server
			const loaded = await loadApplication(true)
			const startup = await replaceHost(loaded.application)
			state.configFiles = loaded.configFiles
			const host = state.host!
			logStaticRuntimeStarted(host, startup, state.configFiles)

			server.httpServer?.once('close', () => {
				const active = state.host
				state.host = undefined
				if (active) {
					void active.stop().catch((error) => {
						server.config.logger.error('[runtime-static/vite] failed to stop static runtime', {
							error: error as Error,
						})
					})
				}
			})

			server.middlewares.use((req, res, next) => {
				const activeHost = state.host
				if (!activeHost) {
					next()
					return
				}
				if (!isStaticRuntimeRouteRequest(req, activeHost)) {
					next()
					return
				}
				void proxyToStaticRuntime(req, res, server, activeHost, next)
			})
		},
		async handleHotUpdate(ctx) {
			const host = state.host
			if (!state.configFiles.has(ctx.file)) return undefined
			const server = state.server ?? ctx.server
			state.server = server
			const viteInvalidated = invalidateStaticRuntimeChangedModules(server, ctx.file)
			invalidateViteSsrModule(server, ctx.file)
			const loaded = await loadApplication(false)
			const application = loaded.application
			const start = performance.now()
			if (
				!host ||
				ctx.file === state.entryPath ||
				application.name !== host.definition.name ||
				!hasCatalogChanges(host.definition, application)
			) {
				const startup = await replaceHost(application)
				state.configFiles = loaded.configFiles
				logStaticRuntimeStarted(state.host!, startup, state.configFiles)
				return []
			}
			const report = await reloadStaticRuntime({
				host,
				definition: toStaticRuntimeDefinition(application),
			})
			state.application = application
			state.configFiles = loaded.configFiles
			logStaticRuntimeHmrUpdated(
				host,
				report,
				ctx.file,
				state.configFiles,
				roundHmrMs(performance.now() - start),
				viteInvalidated,
			)
			return []
		},
	}

	return [...createStaticRuntimeSourcePlugins(), routePlugin]
}

type StaticRuntimeReportSummary = {
	plugins: {
		catalog: number
		enabled: number
		started: number
		disabled: number
		blocked: number
	}
	loaded: string[]
	entries: string[]
	commit?: {
		added: string[]
		removed: string[]
		replaced: string[]
		restarted: string[]
		lifecycleOk: boolean
	}
}

function logStaticRuntimeStarted(
	host: StaticRuntimeHost,
	startup: StaticRuntimeStartupReport,
	configFiles: ReadonlySet<string>,
): void {
	const summary = formatStaticRuntimeReport(host, startup)
	host.ctx.logger.info('HMR report', formatStaticRuntimeHmrReport('startup', summary, configFiles))
}

function logStaticRuntimeHmrUpdated(
	host: StaticRuntimeHost,
	report: StaticRuntimeHmrReport,
	changedFile: string,
	configFiles: ReadonlySet<string>,
	commitMs: number,
	viteInvalidated: number,
): void {
	const summary = formatStaticRuntimeReport(host, report)
	const ok = report.commit?.lifecycleReport.ok ?? false
	const props = {
		ok,
		changedFiles: 1,
		...hmrChangedPreviewProps(
			hmrPathPreview([changedFile], { limit: HMR_PATH_PREVIEW_LIMIT, normalize: normalizePath }),
			HMR_PATH_PREVIEW_LIMIT,
		),
		targets: summary.plugins.catalog,
		affected: affectedStaticRuntimePlugins(report),
		activeServices: summary.plugins.started,
		fallbackRoots: configFiles.size,
		plugins: toHmrPluginTotals(summary),
		invalidated: hmrInvalidated(viteInvalidated),
		commitMs,
		...(ok ? {} : { commitError: 'static runtime reload did not produce a successful commit' }),
	} satisfies HmrUpdatedLogProps
	host.ctx.logger[ok ? 'info' : 'warn']('HMR updated', props)
	host.ctx.logger.info('HMR report', formatStaticRuntimeHmrReport('update', summary, configFiles))
}

function formatStaticRuntimeReport(
	host: StaticRuntimeHost,
	report: StaticRuntimeStartupReport,
): StaticRuntimeReportSummary {
	const catalog = host.describeCatalog().plugins
	const catalogNames = catalog.map(({ name }) => name)
	const entries = report.entries.map(({ name, status, message }) =>
		message ? `${name}:${status} (${message})` : `${name}:${status}`,
	)
	const status = countStatuses(report.entries)
	const runtimeState = host.ctx.runtimeState.snapshot()
	const commit = report.commit
	return {
		plugins: {
			catalog: catalogNames.length,
			enabled: catalog.filter(({ name }) => isPluginEnabled(runtimeState, name)).length,
			started: catalog.filter(({ plugin }) => host.ctx.registry.isRunning(plugin)).length,
			disabled: status.disabled,
			blocked: status.blocked,
		},
		loaded: catalogNames,
		entries,
		commit: commit
			? {
					added: commit.pluginChanges.added.map(String),
					removed: commit.pluginChanges.removed.map(String),
					replaced: commit.pluginChanges.replaced.map(({ from, to }) => `${from} -> ${to}`),
					restarted: commit.pluginChanges.restarted.map(String),
					lifecycleOk: commit.lifecycleReport.ok,
				}
			: undefined,
	}
}

function formatStaticRuntimeHmrReport(
	reason: 'startup' | 'update',
	summary: StaticRuntimeReportSummary,
	configFiles: ReadonlySet<string>,
): HmrReportLogProps {
	const plugins = toHmrPluginTotals(summary)
	return {
		reason,
		scope: {
			roots: 1,
			entries: configFiles.size,
			anchors: 0,
		},
		plugins,
		roots: [
			{
				root: 'static-catalog',
				entries: configFiles.size,
				plugins,
			},
		],
		loaded: summary.loaded,
		entries: summary.entries,
		commit: summary.commit,
	}
}

function toHmrPluginTotals(summary: StaticRuntimeReportSummary): HmrPluginTotals {
	return {
		loaded: summary.plugins.catalog,
		enabled: summary.plugins.enabled,
		running: summary.plugins.started,
	}
}

function affectedStaticRuntimePlugins(report: StaticRuntimeHmrReport): number {
	const restarted = report.commit?.pluginChanges.restarted.map(String) ?? []
	return new Set([...report.added, ...report.removed, ...report.replaced, ...restarted]).size
}

function invalidateStaticRuntimeChangedModules(server: ViteDevServer, changedFile: string): number {
	type ModuleLike = {
		file?: string | null
		importers?: Set<ModuleLike>
	}

	const queue: ModuleLike[] = []
	const seen = new Set<ModuleLike>()
	for (const mod of server.moduleGraph.getModulesByFile(changedFile) ?? []) {
		queue.push(mod as ModuleLike)
	}

	let invalidated = 0
	while (queue.length > 0) {
		const mod = queue.shift()!
		if (seen.has(mod)) continue
		seen.add(mod)
		server.moduleGraph.invalidateModule(
			mod as Parameters<typeof server.moduleGraph.invalidateModule>[0],
		)
		invalidated++
		for (const importer of mod.importers ?? []) queue.push(importer)
	}
	return invalidated
}

function countStatuses(entries: readonly StaticRuntimeStartupReport['entries'][number][]): {
	started: number
	disabled: number
	blocked: number
} {
	let started = 0
	let disabled = 0
	let blocked = 0
	for (const entry of entries) {
		if (entry.status === 'started') started++
		else if (entry.status === 'disabled') disabled++
		else blocked++
	}
	return { started, disabled, blocked }
}

function createStaticRuntimeSourcePlugins(): PluginOption[] {
	return pluxelRuntimeSourceVitePlugins({
		name: 'pluxel:static-runtime-source',
	})
}

function resolveRuntimeEntryPath(server: ViteDevServer, entry: string, route: string): string {
	const raw = String(entry ?? '').trim()
	if (!raw) throw new Error(`[${route}/vite] entry is required`)
	return normalizePath(resolve(server.config.root, raw))
}

function validateStaticRuntimeApplicationModule(
	mod: Record<string, unknown>,
	entryPath: string,
): StaticRuntimeApplication {
	const value = mod.default
	if (value && typeof (value as Promise<unknown>).then === 'function') {
		throw new Error(
			`[runtime-static/vite] ${entryPath} default export must be returned by defineStaticRuntime(...), not a Promise`,
		)
	}
	if (!isStaticRuntimeApplication(value)) {
		throw new Error(
			`[runtime-static/vite] ${entryPath} must default-export defineStaticRuntime(...)`,
		)
	}
	return value
}

function hasCatalogChanges(
	current: StaticRuntimeDefinition,
	next: Pick<StaticRuntimeApplication, 'plugins'>,
): boolean {
	if (current.plugins.length !== next.plugins.length) return true
	return current.plugins.some((plugin, index) => plugin !== next.plugins[index])
}

async function resolveViteBindings(
	bindings: StaticRuntimeVitePluginOptions['bindings'],
): Promise<StaticRuntimeBindings> {
	if (typeof bindings === 'function') return (await bindings()) ?? {}
	return bindings ?? {}
}

async function configureStaticRuntimeDevRuntime(
	server: ViteDevServer,
	host: StaticRuntimeHost,
	pluginDirs: Record<string, string> | undefined,
): Promise<void> {
	const runtimeDev = await loadStaticRuntimeDevModule(server)
	const ctx = host.ctx
	if (!ctx.runtimeRoute) {
		throw new Error('[runtime-static/vite] static route capabilities must be registered first')
	}
	runtimeDev.attachPluginArtifactCompiler(ctx, {
		pluginDirs,
		viteServer: server,
	})
}

function withDevWorkbenchHttpConfig(
	config: StaticRuntimeHost['options']['http'] | undefined,
): StaticRuntimeHost['options']['http'] {
	const next = {
		...config,
		controlPlane: { web: true, rpc: true, sse: true },
		uiAssets: 'dev-server',
	}
	return next
}

async function loadStaticRuntimeDevModule(
	server: ViteDevServer,
): Promise<typeof import('@pluxel/runtime-dev')> {
	const sourceEntry = fileURLToPath(new URL('../../runtime-dev/src/index.ts', import.meta.url))
	if (existsSync(sourceEntry)) {
		return importViteSsrModule(server, sourceEntry) as Promise<typeof import('@pluxel/runtime-dev')>
	}
	return import('@pluxel/runtime-dev')
}

function isStaticRuntimeRouteRequest(
	request: IncomingMessage,
	host: Pick<StaticRuntimeHost, 'ctx'>,
): boolean {
	const url = request.url ?? '/'
	const pathname = requestPathname(url)
	if (url.startsWith('/__pluxel/')) return true
	const http = host.ctx.http as unknown as { matchesMountedRoute?: (pathname: string) => boolean }
	if (http.matchesMountedRoute?.(pathname)) return true

	const method = (request.method ?? 'GET').toUpperCase()
	if (method !== 'GET' && method !== 'HEAD') return false
	if (url.startsWith('/@') || url.startsWith('/node_modules/') || url.includes('.')) return false
	if (!host.ctx.workbench.enabled) return false

	const accept = String(request.headers.accept ?? '').toLowerCase()
	return accept.includes('text/html')
}

function requestPathname(url: string): string {
	try {
		return new URL(url, 'http://local').pathname
	} catch {
		return url.split(/[?#]/, 1)[0] || '/'
	}
}

type ViteSsrModuleLike = {
	readonly file?: string | null
	readonly ssrModule?: Record<string, unknown> | null
}

function resolveStaticRuntimePluginDirs(
	server: ViteDevServer,
	host: StaticRuntimeHost,
): Record<string, string> | undefined {
	const modules = moduleGraphEntries(server)
	if (modules.length === 0) return undefined

	const pluginDirs: Record<string, string> = {}
	for (const { name, plugin } of host.describeCatalog().plugins) {
		const pluginDir = findSsrExportDir(modules, plugin)
		if (pluginDir) pluginDirs[name] = pluginDir
	}
	return Object.keys(pluginDirs).length > 0 ? pluginDirs : undefined
}

function moduleGraphEntries(server: ViteDevServer): ViteSsrModuleLike[] {
	const graph = server.moduleGraph as unknown as {
		idToModuleMap?: Map<string, ViteSsrModuleLike>
	}
	const values = graph.idToModuleMap?.values()
	return values ? [...values] : []
}

function findSsrExportDir(
	modules: readonly ViteSsrModuleLike[],
	plugin: unknown,
): string | undefined {
	for (const module of modules) {
		if (!module.file || !module.ssrModule) continue
		for (const value of Object.values(module.ssrModule)) {
			if (value === plugin) return dirname(module.file)
		}
	}
	return undefined
}

async function proxyToStaticRuntime(
	req: IncomingMessage,
	res: ServerResponse,
	server: ViteDevServer,
	host: StaticRuntimeHost,
	next: (error?: unknown) => void,
): Promise<void> {
	try {
		const response = await host.ctx.http.fetch(toRequest(req, server))
		await writeResponse(res, response)
	} catch (error) {
		next(error)
	}
}

function toRequest(req: IncomingMessage, server: ViteDevServer): Request {
	const origin = resolveViteOrigin(server)
	const method = req.method ?? 'GET'
	const headers = new Headers()
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item)
			continue
		}
		headers.set(key, value)
	}

	const init: RequestInit & { duplex?: 'half' } = { method, headers }
	if (method !== 'GET' && method !== 'HEAD') {
		init.body = req as unknown as BodyInit
		init.duplex = 'half'
	}

	return new Request(new URL(req.url ?? '/', origin), init)
}

function resolveViteOrigin(server: ViteDevServer): string {
	const address = server.httpServer?.address()
	const port =
		typeof address === 'object' && address ? address.port : (server.config.server.port ?? 5173)
	return `http://127.0.0.1:${port}`
}

async function writeResponse(res: ServerResponse, response: Response): Promise<void> {
	res.statusCode = response.status
	response.headers.forEach((value, key) => res.setHeader(key, value))
	if (!response.body) {
		res.end()
		return
	}

	const { Readable } = await import('node:stream')
	await new Promise<void>((resolveStream, reject) => {
		Readable.fromWeb(response.body as unknown as import('node:stream/web').ReadableStream)
			.on('error', reject)
			.pipe(res)
			.on('finish', resolveStream)
			.on('error', reject)
	})
}
