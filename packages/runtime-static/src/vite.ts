import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env as runtimeEnvironment } from '@pluxel/runtime/environment'
import {
	attachSrvxViteNodeCarrier,
	collectViteSsrImportFiles,
	createHostModuleVitePlugin,
	createViteNodeElysiaApplicationCarrier,
	createWorkbenchViteClientConfig,
	importViteSsrModule,
	invalidateViteSsrModule,
	type SrvxViteNodeCarrierAttachment,
} from '../../runtime-dev/src/vite.ts'
import { staticConfigEnvironmentVitePlugin } from '@pluxel/rolldown/internal/static-config-environment-vite'
import {
	createPluginSourceVitePipeline,
	type PluginSourceVitePipeline,
} from '@pluxel/rolldown/vite'
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
import { shouldHandleRuntimeViteRequest } from '../../runtime-dev/src/internal/vite-route-request.ts'
import {
	readHostProduct,
	readRuntimePluginStatusOverview,
	readRuntimeRouteCapabilities,
	requireRuntimeHttpService,
	resolveDevWorkbenchClientEntryUrl,
	sameProduct,
} from '@pluxel/runtime/internal'
import { createWorkbenchBackend } from '@pluxel/runtime/internal/static'
import type { ProductDescriptor } from '@pluxel/runtime/product'
import { formatPluginNodeReference } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import type { IncomingMessage } from 'node:http'
import { normalizePath, type Plugin, type PluginOption, type ViteDevServer } from 'vite'

import { reloadStaticRuntime } from './hmr.ts'
import { isStaticRuntimeApplication, resolveStaticRuntimeHostOptions } from './application.ts'
import { toStaticRuntimeDefinition } from './internal/application.ts'
import { createStaticRuntimeHost } from './internal/host.ts'
import type {
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeDefinition,
	StaticRuntimeHost,
	StaticRuntimeHmrReport,
	StaticRuntimeStartupReport,
	StaticRuntimeStartupContext,
} from './types.ts'

const STATIC_RUNTIME_SERVER_KEY = Symbol.for('pluxel.staticRuntimeVitePlugin')
const STATIC_RUNTIME_CACHE_DIR = '.pluxel/vite/static-runtime-v2'

type StaticViteApplicationCarrier = ReturnType<typeof createViteNodeElysiaApplicationCarrier>

export type StaticRuntimeVitePluginOptions = {
	entry: string
	bindings?: StaticRuntimeBindings | (() => StaticRuntimeBindings | Promise<StaticRuntimeBindings>)
}

export function staticRuntimeVitePlugin(options: StaticRuntimeVitePluginOptions): PluginOption[] {
	const sourcePipeline = createPluginSourceVitePipeline({
		name: 'pluxel:static-runtime-source',
	})
	const artifactPublishers = new WeakMap<StaticRuntimeHost, () => Promise<void>>()
	const state: {
		server?: ViteDevServer
		entryPath?: string
		configFiles: Set<string>
		application?: StaticRuntimeApplication
		product?: ProductDescriptor | null
		host?: StaticRuntimeHost
		carrier?: SrvxViteNodeCarrierAttachment
		applicationCarrier?: StaticViteApplicationCarrier
		detachApplicationCarrier?: () => void
	} = {
		configFiles: new Set(),
	}

	const loadApplication = async (
		fresh: boolean,
	): Promise<{
		application: StaticRuntimeApplication
		product: ProductDescriptor | null
		configFiles: Set<string>
	}> => {
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
			product: readHostProduct(mod, `[runtime-static/vite] ${entryPath}`),
			configFiles: collectViteSsrImportFiles(server, entryPath),
		}
	}

	const createHost = async (
		application: StaticRuntimeApplication,
		product: ProductDescriptor | null,
	): Promise<StaticRuntimeHost> => {
		const server = state.server
		if (!server) throw new Error('[runtime-static/vite] Vite server is not configured')
		const startup: StaticRuntimeStartupContext = {
			mode: 'development',
			env: runtimeEnvironment,
			bindings: await resolveViteBindings(options.bindings),
		}
		const config = await resolveStaticRuntimeHostOptions(application, startup, {
			workbench: true,
		})
		const host = await createStaticRuntimeHost(toStaticRuntimeDefinition(application), config, {
			createWorkbenchBackend,
			product,
			...(config.workbench !== false && config.workbench?.enabled === true
				? { http: { uiAssets: 'dev-server' } }
				: {}),
		})
		try {
			const publishArtifacts = await configureStaticRuntimeDevRuntime(
				server,
				host,
				sourcePipeline.semantics,
			)
			artifactPublishers.set(host, publishArtifacts)
			await application.prepare?.({ host, startup })
			return host
		} catch (error) {
			await host.stop().catch((): undefined => undefined)
			throw error
		}
	}

	async function replaceHost(
		application: StaticRuntimeApplication,
		product: ProductDescriptor | null,
	): Promise<StaticRuntimeStartupReport> {
		const previousHost = state.host
		const previousApplication = state.application
		const previousProduct = state.product ?? null
		if (previousHost) {
			try {
				await previousHost.stop()
			} finally {
				state.detachApplicationCarrier?.()
				state.detachApplicationCarrier = undefined
				state.host = undefined
			}
		}

		let next: StaticRuntimeHost | undefined
		try {
			next = await createHost(application, product)
			const applicationCarrier = state.applicationCarrier
			if (!applicationCarrier) {
				throw new Error('[runtime-static/vite] Elysia application carrier is not configured')
			}
			const detachApplicationCarrier = requireRuntimeHttpService(next.ctx).attachApplicationCarrier(
				applicationCarrier,
			)
			state.detachApplicationCarrier = detachApplicationCarrier
			const startup = await next.start()
			state.host = next
			state.application = application
			state.product = product
			return startup
		} catch (error) {
			await next?.stop().catch((): undefined => undefined)
			state.detachApplicationCarrier?.()
			state.detachApplicationCarrier = undefined
			if (previousHost && previousApplication) {
				let restored: StaticRuntimeHost | undefined
				try {
					restored = await createHost(previousApplication, previousProduct)
					const applicationCarrier = state.applicationCarrier
					if (!applicationCarrier) {
						throw new Error('[runtime-static/vite] Elysia application carrier is not configured', {
							cause: error,
						})
					}
					state.detachApplicationCarrier = requireRuntimeHttpService(
						restored.ctx,
					).attachApplicationCarrier(applicationCarrier)
					await restored.start()
					state.host = restored
					state.application = previousApplication
					state.product = previousProduct
				} catch (rollbackError) {
					await restored?.stop().catch((): undefined => undefined)
					state.detachApplicationCarrier?.()
					state.detachApplicationCarrier = undefined
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
			state.applicationCarrier = createViteNodeElysiaApplicationCarrier(server, {
				fetch: (request) => {
					const activeHost = state.host
					if (!activeHost) return new Response('Static runtime is not ready', { status: 503 })
					return activeHost.fetch(request)
				},
				matches: (request) => {
					const activeHost = state.host
					return Boolean(
						activeHost && requireRuntimeHttpService(activeHost.ctx).matchesWebSocketRoute(request),
					)
				},
			})
			try {
				const loaded = await loadApplication(true)
				const startup = await replaceHost(loaded.application, loaded.product)
				state.configFiles = loaded.configFiles
				const host = state.host!
				await logStaticRuntimeStarted(host, startup, state.configFiles)

				state.carrier = attachSrvxViteNodeCarrier(server, {
					transformViteHtml: true,
					fetch(request) {
						const activeHost = state.host
						if (!activeHost) {
							return Promise.resolve(new Response('Static runtime is not ready', { status: 503 }))
						}
						return activeHost.fetch(request)
					},
					shouldHandle(request) {
						const activeHost = state.host
						return Boolean(activeHost && isStaticRuntimeRouteRequest(request, activeHost))
					},
					...(server.httpServer
						? {
								businessWebSocket: {
									matches: (request: IncomingMessage) =>
										state.applicationCarrier?.matchesUpgrade(request) ?? false,
									handle: (
										request: IncomingMessage,
										socket: import('node:stream').Duplex,
										head: Buffer,
									) => state.applicationCarrier?.handleUpgrade(request, socket, head),
								},
							}
						: {}),
				})
			} catch (error) {
				state.applicationCarrier.stopAccepting()
				await state.host?.stop().catch((): undefined => undefined)
				state.detachApplicationCarrier?.()
				state.detachApplicationCarrier = undefined
				state.host = undefined
				await state.applicationCarrier.close().catch((): undefined => undefined)
				state.applicationCarrier = undefined
				throw error
			}
		},
		async closeBundle() {
			const applicationCarrier = state.applicationCarrier
			applicationCarrier?.stopAccepting()
			const active = state.host
			state.host = undefined
			const carrier = state.carrier
			state.carrier = undefined
			let hostError: unknown
			try {
				if (active) await active.stop()
			} catch (error) {
				hostError = error
			}
			state.detachApplicationCarrier?.()
			state.detachApplicationCarrier = undefined
			let httpError: unknown
			try {
				await carrier?.close()
			} catch (error) {
				httpError = error
			}
			state.applicationCarrier = undefined
			let applicationCarrierError: unknown
			try {
				await applicationCarrier?.close()
			} catch (error) {
				applicationCarrierError = error
			}
			const errors = [hostError, httpError, applicationCarrierError].filter(
				(error) => error !== undefined,
			)
			if (errors.length === 1) throw errors[0]
			if (errors.length > 1) {
				throw new AggregateError(errors, '[runtime-static/vite] carrier shutdown failed')
			}
		},
		async handleHotUpdate(ctx) {
			const host = state.host
			if (!state.configFiles.has(ctx.file)) {
				await (host ? artifactPublishers.get(host)?.() : undefined)
				if (host && requireRuntimeHttpService(host.ctx).consumeFullReloadRequest()) {
					ctx.server.ws.send({ type: 'full-reload' })
					return []
				}
				return undefined
			}
			const server = state.server ?? ctx.server
			state.server = server
			const viteInvalidated = invalidateStaticRuntimeChangedModules(
				server,
				ctx.file,
				state.configFiles,
			)
			invalidateViteSsrModule(server, ctx.file)
			// The canonical application is a configuration boundary, not an independently retained
			// module. Clear the single SSR runner's evaluated namespace after Vite transform-graph
			// invalidation so consecutive edits cannot reuse an importer namespace that still points at
			// the previous package-root implementation.
			const loaded = await loadApplication(true)
			const application = loaded.application
			const productChanged = !sameProduct(state.product ?? null, loaded.product)
			const start = performance.now()
			if (
				!host ||
				ctx.file === state.entryPath ||
				application.name !== host.definition.name ||
				productChanged ||
				!hasCatalogChanges(host.definition, application)
			) {
				const startup = await replaceHost(application, loaded.product)
				state.configFiles = loaded.configFiles
				await logStaticRuntimeStarted(state.host!, startup, state.configFiles)
				if (productChanged) ctx.server.ws.send({ type: 'full-reload' })
				return []
			}
			await artifactPublishers.get(host)?.()
			const report = await reloadStaticRuntime({
				host,
				definition: toStaticRuntimeDefinition(application),
			})
			state.application = application
			state.product = loaded.product
			state.configFiles = loaded.configFiles
			await logStaticRuntimeHmrUpdated(
				host,
				report,
				ctx.file,
				state.configFiles,
				roundHmrMs(performance.now() - start),
				viteInvalidated,
			)
			if (requireRuntimeHttpService(host.ctx).consumeFullReloadRequest()) {
				ctx.server.ws.send({ type: 'full-reload' })
			}
			return []
		},
	}

	return [
		staticConfigEnvironmentVitePlugin({ entry: options.entry }),
		...sourcePipeline.plugins,
		createHostModuleVitePlugin(),
		routePlugin,
	]
}

type StaticRuntimeReportSummary = {
	plugins: {
		catalog: number
		desired: number
		running: number
		stopped: number
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

async function logStaticRuntimeStarted(
	host: StaticRuntimeHost,
	startup: StaticRuntimeStartupReport,
	configFiles: ReadonlySet<string>,
): Promise<void> {
	const summary = await formatStaticRuntimeReport(host, startup)
	host.ctx.logger.info('HMR report', formatStaticRuntimeHmrReport('startup', summary, configFiles))
}

async function logStaticRuntimeHmrUpdated(
	host: StaticRuntimeHost,
	report: StaticRuntimeHmrReport,
	changedFile: string,
	configFiles: ReadonlySet<string>,
	commitMs: number,
	viteInvalidated: number,
): Promise<void> {
	const summary = await formatStaticRuntimeReport(host, report)
	const ok = report.commit?.lifecycleReport.ok ?? false
	const props = {
		ok,
		changedFiles: 1,
		...hmrChangedPreviewProps(
			hmrPathPreview([changedFile], { limit: HMR_PATH_PREVIEW_LIMIT, normalize: normalizePath }),
			HMR_PATH_PREVIEW_LIMIT,
		),
		targets: summary.plugins.catalog,
		affected: affectedStaticRuntimePlugins(host, report),
		activeServices: summary.plugins.running,
		fallbackRoots: configFiles.size,
		plugins: toHmrPluginTotals(summary),
		invalidated: hmrInvalidated(viteInvalidated),
		commitMs,
		...(ok ? {} : { commitError: 'static runtime reload did not produce a successful commit' }),
	} satisfies HmrUpdatedLogProps
	host.ctx.logger[ok ? 'info' : 'warn']('HMR updated', props)
	host.ctx.logger.info('HMR report', formatStaticRuntimeHmrReport('update', summary, configFiles))
}

async function formatStaticRuntimeReport(
	host: StaticRuntimeHost,
	report: StaticRuntimeStartupReport,
): Promise<StaticRuntimeReportSummary> {
	const catalog = host.describeCatalog().plugins
	const catalogLabels = catalog.map(
		({ address, displayName }) => `${displayName} (${formatPluginNodeReference(address)})`,
	)
	const entries = report.entries.map(({ address, displayName, status, message }) =>
		message
			? `${displayName} [${formatPluginNodeReference(address)}]:${status} (${message})`
			: `${displayName} [${formatPluginNodeReference(address)}]:${status}`,
	)
	const status = countStatuses(report.entries)
	const overview = await readRuntimePluginStatusOverview(host.ctx)
	const pluginService = requirePluginService(host.ctx)
	const commit = report.commit
	return {
		plugins: {
			catalog: catalogLabels.length,
			desired: overview.statuses.filter((entry) => entry.desiredState === 'running').length,
			running: overview.statuses.filter((entry) => entry.lifecycleState === 'running').length,
			stopped: status.stopped,
			blocked: status.blocked,
		},
		loaded: catalogLabels,
		entries,
		commit: commit
			? {
					added: commit.pluginChanges.added.map((slot) =>
						formatPluginNodeReference(pluginService.nodeAddressOf(slot)),
					),
					removed: commit.pluginChanges.removed.map((slot) =>
						formatPluginNodeReference(pluginService.nodeAddressOf(slot)),
					),
					replaced: commit.pluginChanges.replaced.map(
						({ from, to }) =>
							`${formatPluginNodeReference(pluginService.nodeAddressOf(from))} -> ${formatPluginNodeReference(pluginService.nodeAddressOf(to))}`,
					),
					restarted: commit.pluginChanges.restarted.map((slot) =>
						formatPluginNodeReference(pluginService.nodeAddressOf(slot)),
					),
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
		desired: summary.plugins.desired,
		running: summary.plugins.running,
	}
}

function affectedStaticRuntimePlugins(
	host: StaticRuntimeHost,
	report: StaticRuntimeHmrReport,
): number {
	const pluginService = requirePluginService(host.ctx)
	const affected = new Set<string>()
	for (const address of [...report.added, ...report.removed, ...report.replaced]) {
		affected.add(formatPluginNodeReference(address))
	}
	for (const slot of report.commit?.pluginChanges.restarted ?? []) {
		affected.add(formatPluginNodeReference(pluginService.nodeAddressOf(slot)))
	}
	return affected.size
}

function invalidateStaticRuntimeChangedModules(
	server: ViteDevServer,
	changedFile: string,
	applicationFiles: ReadonlySet<string>,
): number {
	type ModuleLike = {
		file?: string | null
		importers?: Set<ModuleLike>
	}

	const queue: ModuleLike[] = []
	const seen = new Set<ModuleLike>()
	const graph = server.environments.ssr.moduleGraph
	for (const mod of graph.getModulesByFile(changedFile) ?? []) {
		queue.push(mod as ModuleLike)
	}
	// Package-root imports may be indexed by a resolved symlink target while Vite reports the
	// physical watcher path (or vice versa). If that exact lookup misses, invalidate only the known
	// canonical application graph so the fresh SSR evaluation cannot consume a stale transform.
	if (queue.length === 0) {
		for (const file of applicationFiles) {
			for (const mod of graph.getModulesByFile(file) ?? []) {
				queue.push(mod as ModuleLike)
			}
		}
	}

	let invalidated = 0
	while (queue.length > 0) {
		const mod = queue.shift()!
		if (seen.has(mod)) continue
		seen.add(mod)
		graph.invalidateModule(mod as Parameters<typeof graph.invalidateModule>[0])
		invalidated++
		for (const importer of mod.importers ?? []) queue.push(importer)
	}
	return invalidated
}

function countStatuses(entries: readonly StaticRuntimeStartupReport['entries'][number][]): {
	started: number
	stopped: number
	blocked: number
} {
	let started = 0
	let stopped = 0
	let blocked = 0
	for (const entry of entries) {
		if (entry.status === 'started') started++
		else if (entry.status === 'stopped') stopped++
		else blocked++
	}
	return { started, stopped, blocked }
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
	semantics: Pick<
		PluginSourceVitePipeline['semantics'],
		'invalidateWorkbench' | 'workbenchCompilations' | 'workbenchContentCompilations'
	>,
): Promise<() => Promise<void>> {
	const runtimeDev = await loadStaticRuntimeDevModule(server)
	const ctx = host.ctx
	if (!readRuntimeRouteCapabilities(ctx)) {
		throw new Error('[runtime-static/vite] static route capabilities must be registered first')
	}
	const compiler = runtimeDev.attachPluginArtifactCompiler(ctx, {
		packageMode: 'development',
		viteServer: server,
	})
	const publish = async (): Promise<void> => {
		if (!ctx.workbench) return
		semantics.invalidateWorkbench()
		const [producers, content] = await Promise.all([
			semantics.workbenchCompilations(),
			semantics.workbenchContentCompilations(),
		])
		await compiler.publishWorkbenchArtifacts({ producers, content })
	}
	await publish()
	requireRuntimeHttpService(ctx).consumeFullReloadRequest()
	return publish
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
	const workbenchEnabled = host.ctx.workbench !== undefined
	const http = requireRuntimeHttpService(host.ctx)
	return shouldHandleRuntimeViteRequest({
		url,
		method: request.method,
		accept: String(request.headers.accept ?? ''),
		workbenchEnabled,
		matchesMountedRoute: (pathname) => http.matchesMountedRoute(pathname),
		matchesWorkbenchUiRoute: (pathname) => http.matchesWorkbenchUiRoute(pathname),
	})
}
