import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { env as runtimeEnvironment, hostEnv } from '@pluxel/runtime/environment'
import {
	attachSrvxViteNodeCarrier,
	collectViteSsrImportFiles,
	createHostModuleVitePlugin,
	installPluxelViteUrlPrinter,
	createViteNodeElysiaApplicationCarrier,
	createWorkbenchViteClientConfig,
	importViteSsrModule,
	invalidateViteSsrModule,
	type SrvxViteNodeCarrierAttachment,
} from '../../runtime-dev/src/vite.ts'
import { ViteApplicationRecovery } from '../../runtime-dev/src/internal/vite-application-recovery.ts'
import { attachDevConsole, type DevConsoleAttachment } from '../../runtime-dev/src/console.ts'
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
	type PluginExecutionSnapshot,
} from '@pluxel/runtime/internal'
import { createWorkbenchBackend } from '@pluxel/runtime/internal/static'
import type { ProductDescriptor } from '@pluxel/runtime/product'
import {
	formatPluginNodeReference,
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import type { IncomingMessage } from 'node:http'
import {
	normalizePath,
	type HotUpdateOptions,
	type EnvironmentModuleNode,
	type Plugin,
	type PluginOption,
	type ViteDevServer,
} from 'vite'

import { isStaticRuntimeApplication, resolveStaticRuntimeHostOptions } from './application.ts'
import { toStaticRuntimeDefinition } from './internal/application.ts'
import { createStaticRuntimeHost, type StaticRuntimeHostImpl } from './internal/host.ts'
import { StaticRuntimeRecentUpdateTracker } from './internal/recent-update.ts'
import type {
	StaticRuntimeApplication,
	StaticRuntimeBindings,
	StaticRuntimeDefinition,
	StaticRuntimeHost,
	StaticRuntimeInternalHmrReport,
	StaticRuntimeInternalStartupReport,
	StaticRuntimeStartupContext,
} from './types.ts'

const STATIC_RUNTIME_SERVER_KEY = Symbol.for('pluxel.staticRuntimeVitePlugin')
const STATIC_RUNTIME_CACHE_DIR = '.pluxel/vite/static-runtime-v2'
const STATIC_VITE_SOURCE_EXECUTION = Object.freeze({
	kind: 'static-catalog' as const,
	artifact: Object.freeze({ kind: 'source-module' as const }),
	update: Object.freeze({ kind: 'catalog-hmr' as const }),
}) satisfies PluginExecutionSnapshot
const STATIC_VITE_BUILT_EXECUTION = Object.freeze({
	kind: 'static-catalog' as const,
	artifact: Object.freeze({ kind: 'built-module' as const }),
	update: Object.freeze({ kind: 'catalog-hmr' as const }),
}) satisfies PluginExecutionSnapshot
const STATIC_VITE_UNREPORTED_EXECUTION = Object.freeze({
	kind: 'static-catalog' as const,
	artifact: Object.freeze({ kind: 'unreported' as const }),
	update: Object.freeze({ kind: 'catalog-hmr' as const }),
}) satisfies PluginExecutionSnapshot

type StaticViteExecutionResolver = (definition: PluginDefinitionAddress) => PluginExecutionSnapshot

type StaticViteApplicationCarrier = ReturnType<typeof createViteNodeElysiaApplicationCarrier>

export type StaticRuntimeVitePluginOptions = {
	/** Enable trusted local TypeScript operations on the current dev host. @default false */
	devConsole?: boolean
	entry: string
	bindings?: StaticRuntimeBindings | (() => StaticRuntimeBindings | Promise<StaticRuntimeBindings>)
}

export function staticRuntimeVitePlugin(options: StaticRuntimeVitePluginOptions): PluginOption[] {
	if (options.devConsole !== undefined && typeof options.devConsole !== 'boolean') {
		throw new TypeError('[runtime-static/vite] devConsole must be a boolean')
	}
	const hostEpochs = new WeakMap<StaticRuntimeHostImpl, string>()
	let devConsole: DevConsoleAttachment | undefined
	let closing = false
	const workbenchClientEntry = resolveDevWorkbenchClientEntryUrl()
	const sourcePipeline = createPluginSourceVitePipeline({
		name: 'pluxel:static-runtime-source',
	})
	const artifactPreparers = new WeakMap<
		StaticRuntimeHost,
		() => Promise<PreparedStaticArtifacts | undefined>
	>()
	const activeModulesByHost = new WeakMap<StaticRuntimeHostImpl, { current: ReadonlySet<string> }>()
	const recentUpdates = new StaticRuntimeRecentUpdateTracker()
	const recovery = new ViteApplicationRecovery()
	const state: {
		server?: ViteDevServer
		entryPath?: string
		configFiles: Set<string>
		application?: StaticRuntimeApplication
		product?: ProductDescriptor | null
		host?: StaticRuntimeHostImpl
		carrier?: SrvxViteNodeCarrierAttachment
		applicationCarrier?: StaticViteApplicationCarrier
		detachApplicationCarrier?: () => void
	} = {
		configFiles: new Set(),
	}
	let hotUpdateTail: Promise<void> = Promise.resolve()
	const enqueueHotUpdate = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = hotUpdateTail.then(operation)
		hotUpdateTail = result.then(
			(): void => undefined,
			(): void => undefined,
		)
		return result
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
		if (fresh) invalidateViteSsrModule(server, entryPath)
		const mod = await importViteSsrModule(server, entryPath)
		return {
			application: validateStaticRuntimeApplicationModule(mod, entryPath),
			product: readHostProduct(mod, `[runtime-static/vite] ${entryPath}`),
			configFiles: collectViteSsrImportFiles(server, entryPath),
		}
	}

	const createHost = async (
		application: StaticRuntimeApplication,
		product: ProductDescriptor | null,
		configFiles: ReadonlySet<string>,
		resolveExecution?: StaticViteExecutionResolver,
	): Promise<StaticRuntimeHostImpl> => {
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
		const activeModules = { current: new Set(configFiles) as ReadonlySet<string> }
		const host = await createStaticRuntimeHost(toStaticRuntimeDefinition(application), config, {
			createWorkbenchBackend,
			devConsole: options.devConsole,
			product,
			recentUpdates,
			resolveExecution:
				resolveExecution ??
				((definition) =>
					staticViteExecution(
						sourcePipeline.semantics.classifyDefinitionArtifact(definition, activeModules.current),
					)),
			...(config.workbench !== false && config.workbench?.enabled === true
				? { http: { uiAssets: workbenchClientEntry ? 'dev-server' : 'static-built' } }
				: {}),
		})
		hostEpochs.set(host, randomUUID())
		activeModulesByHost.set(host, activeModules)
		try {
			const prepareArtifacts = await configureStaticRuntimeDevRuntime(
				server,
				host,
				sourcePipeline.semantics,
			)
			artifactPreparers.set(host, prepareArtifacts)
			await application.prepare?.({ host, startup })
			return host
		} catch (error) {
			await host.stop().catch((): undefined => undefined)
			throw error
		}
	}

	async function replaceHost(input: {
		application: StaticRuntimeApplication
		product: ProductDescriptor | null
		configFiles: ReadonlySet<string>
		updateStartedAt?: number
	}): Promise<StaticRuntimeInternalStartupReport> {
		const { application, product, configFiles, updateStartedAt } = input
		const previousHost = state.host
		const previousApplication = state.application
		const previousProduct = state.product ?? null
		const previousConfigFiles = new Set(state.configFiles)
		const previousCatalog = previousHost?.catalogSnapshotForVite() ?? []
		const previousDefinitions = previousCatalog.map((entry) => entry.address.definition)
		const previousExecution = new Map(
			previousCatalog.map((entry) => [
				pluginDefinitionIndexKey(entry.address.definition),
				entry.execution,
			]),
		)
		const restoreExecution: StaticViteExecutionResolver = (definition) =>
			previousExecution.get(pluginDefinitionIndexKey(definition)) ??
			STATIC_VITE_UNREPORTED_EXECUTION

		let next: StaticRuntimeHostImpl | undefined
		try {
			if (previousHost) {
				await devConsole?.hostChanged()
				try {
					await previousHost.stop()
				} finally {
					state.detachApplicationCarrier?.()
					state.detachApplicationCarrier = undefined
					state.host = undefined
				}
			}
			next = await createHost(application, product, configFiles)
			const applicationCarrier = state.applicationCarrier
			if (!applicationCarrier) {
				throw new Error('[runtime-static/vite] Elysia application carrier is not configured')
			}
			const detachApplicationCarrier = requireRuntimeHttpService(next.ctx).attachApplicationCarrier(
				applicationCarrier,
			)
			state.detachApplicationCarrier = detachApplicationCarrier
			const startedHost = next
			const startup = await startedHost.start()
			state.host = next
			state.application = application
			state.product = product
			state.configFiles = new Set(configFiles)
			if (updateStartedAt !== undefined) {
				recentUpdates.recordDefinitions(
					[
						...previousDefinitions,
						...next.describeCatalog().plugins.map((entry) => entry.definition),
					],
					startup.commit && !startup.commit.lifecycleReport.ok
						? {
								outcome: 'applied-with-issues',
								phase: 'lifecycle',
								durationMs: elapsedStaticRuntimeUpdateMs(updateStartedAt),
							}
						: {
								outcome: 'applied',
								phase: null,
								durationMs: elapsedStaticRuntimeUpdateMs(updateStartedAt),
							},
					{
						scope: 'application',
						...(startup.commit
							? {
									lifecycle: {
										commit: startup.commit,
										addressOf: (slot) => requirePluginService(startedHost.ctx).nodeAddressOf(slot),
									},
								}
							: {}),
					},
				)
			}
			return startup
		} catch (error) {
			await next?.stop().catch((): undefined => undefined)
			state.detachApplicationCarrier?.()
			state.detachApplicationCarrier = undefined
			state.host = undefined
			if (previousHost && previousApplication) {
				let restored: StaticRuntimeHostImpl | undefined
				try {
					restored = await createHost(
						previousApplication,
						previousProduct,
						previousConfigFiles,
						restoreExecution,
					)
					const applicationCarrier = state.applicationCarrier
					if (!applicationCarrier) {
						throw new Error('[runtime-static/vite] Elysia application carrier is not configured', {
							cause: error,
						})
					}
					state.detachApplicationCarrier = requireRuntimeHttpService(
						restored.ctx,
					).attachApplicationCarrier(applicationCarrier)
					const restoredHost = restored
					const restoredStartup = await restoredHost.start()
					state.host = restored
					state.application = previousApplication
					state.product = previousProduct
					state.configFiles = previousConfigFiles
					if (updateStartedAt !== undefined) {
						recentUpdates.recordDefinitions(
							previousDefinitions,
							{
								outcome: 'restored-previous',
								phase: 'application-reload',
								durationMs: elapsedStaticRuntimeUpdateMs(updateStartedAt),
							},
							{
								scope: 'application',
								...(restoredStartup.commit
									? {
											lifecycle: {
												commit: restoredStartup.commit,
												addressOf: (slot) =>
													requirePluginService(restoredHost.ctx).nodeAddressOf(slot),
											},
										}
									: {}),
							},
						)
					}
				} catch (rollbackError) {
					await restored?.stop().catch((): undefined => undefined)
					state.detachApplicationCarrier?.()
					state.detachApplicationCarrier = undefined
					state.host = undefined
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

	const applyHotUpdate = (ctx: HotUpdateOptions): Promise<EnvironmentModuleNode[] | void> => {
		if (closing) return Promise.resolve(undefined)
		devConsole?.invalidate(ctx.file)
		devConsole?.observed(ctx.file)
		return enqueueHotUpdate(async (): Promise<EnvironmentModuleNode[] | void> => {
			const host = state.host
			if (!state.configFiles.has(ctx.file) && !recovery.matches(ctx.file)) {
				const prepare = host ? artifactPreparers.get(host) : undefined
				if (!prepare || !host?.ctx.workbench) return undefined
				const start = performance.now()
				recentUpdates.beginUpdate(portableUpdatePath(ctx.file, ctx.server.config.root))
				recentUpdates.updatePhase('artifacts')
				try {
					const prepared = await prepare()
					prepared?.commit()
					recentUpdates.recordDefinitions(
						[],
						{ outcome: 'applied', phase: null, durationMs: elapsedStaticRuntimeUpdateMs(start) },
						{ scope: 'application' },
					)
					recentUpdates.finishUpdate()
				} catch (error) {
					recentUpdates.recordDefinitions(
						[],
						{
							outcome: 'retained-previous',
							phase: 'artifacts',
							durationMs: elapsedStaticRuntimeUpdateMs(start),
						},
						{ scope: 'application' },
					)
					recentUpdates.finishUpdate(describeUpdateError(error, ctx.server.config.root))
					host?.ctx.logger.error('Workbench artifact refresh failed', {
						error,
						batch: recentUpdates.latestUpdate(),
					})
					throw error
				}
				if (host && sendRequestedStaticRuntimeFullReload(ctx.server, host)) return []
				return undefined
			}
			const server = state.server ?? ctx.server
			state.server = server
			const start = performance.now()
			const viteInvalidation = invalidateStaticRuntimeChangedModules({
				server,
				changedFile: ctx.file,
				applicationFiles: recovery.invalidationFiles(state.configFiles),
				changedModules: ctx.modules,
				recoverMissingImports: ctx.type === 'create' || recovery.matches(ctx.file),
			})
			const evaluationTargets = affectedStaticRuntimeDefinitions(
				host,
				sourcePipeline.semantics,
				viteInvalidation.modules,
				ctx.file === state.entryPath,
			)
			// A failed import can lose its file identity in the runner. Invalidate the
			// known importer closure as well so recreating that file retries evaluation.
			for (const module of viteInvalidation.modules) invalidateViteSsrModule(server, module)
			// Normal edits preserve unrelated Plugin constructors; recreated imports use the recovery closure.
			const artifactGeneration = sourcePipeline.semantics.beginArtifactGeneration()
			recovery.begin(state.entryPath!)
			recentUpdates.beginUpdate(portableUpdatePath(ctx.file, server.config.root))
			let preparedArtifacts: PreparedStaticArtifacts | undefined
			try {
				return await artifactGeneration.run(async (): Promise<EnvironmentModuleNode[] | void> => {
					let loaded: Awaited<ReturnType<typeof loadApplication>>
					try {
						loaded = await loadApplication(true)
					} catch (error) {
						artifactGeneration.rollback()
						// Vite reports an unlink to watchChange before this hook. That removes the
						// deleted module's semantic facts, so an evaluation failure can leave no exact
						// targets even though the previous static catalog is still authoritative.
						recentUpdates.recordDefinitions(
							evaluationTargets,
							{
								outcome: 'retained-previous',
								phase: 'evaluate',
								durationMs: elapsedStaticRuntimeUpdateMs(start),
							},
							{ scope: evaluationTargets.length > 0 ? 'definitions' : 'application' },
						)
						throw error
					}
					const application = loaded.application
					const productChanged = !sameProduct(state.product ?? null, loaded.product)
					if (
						!host ||
						ctx.file === state.entryPath ||
						application.name !== host.definition.name ||
						productChanged ||
						!hasCatalogChanges(host.definition, application)
					) {
						let startup: StaticRuntimeInternalStartupReport
						try {
							recentUpdates.updatePhase('application-reload')
							startup = await replaceHost({
								application,
								product: loaded.product,
								configFiles: loaded.configFiles,
								updateStartedAt: start,
							})
						} catch (error) {
							artifactGeneration.rollback()
							throw error
						}
						artifactGeneration.commit()
						await recovery.committed()
						state.configFiles = loaded.configFiles
						const replacementHost = state.host!
						void logStaticRuntimeStarted(replacementHost, startup, state.configFiles).catch(
							(error) => {
								replacementHost.ctx.logger.warn('HMR report failed', { error })
							},
						)
						if (productChanged) sendStaticRuntimeFullReload(ctx.server, replacementHost)
						return []
					}
					try {
						recentUpdates.updatePhase('artifacts')
						preparedArtifacts = await artifactPreparers.get(host)?.()
					} catch (error) {
						artifactGeneration.rollback()
						throw error
					}
					const activeModules = activeModulesByHost.get(host)
					if (!activeModules) {
						artifactGeneration.rollback()
						throw new Error(
							'[runtime-static/vite] active application module closure is unavailable',
						)
					}
					const previousActiveModules = activeModules.current
					activeModules.current = new Set(loaded.configFiles)
					recentUpdates.updatePhase('commit')
					const reload = await host.reloadFromVite(toStaticRuntimeDefinition(application), start, {
						onGraphCommitted: () => preparedArtifacts?.commit(),
					})
					if (reload.status === 'failed') {
						if (reload.catalogCommitted) {
							// The Core graph and route catalog crossed their point of no return even though a
							// later commit step rejected. Keep the module closure and application state aligned
							// with the catalog that callers can now observe.
							state.application = application
							state.product = loaded.product
							state.configFiles = loaded.configFiles
							artifactGeneration.commit()
							await recovery.committed()
						} else {
							activeModules.current = previousActiveModules
							artifactGeneration.rollback()
						}
						throw reload.error
					}
					const report: StaticRuntimeInternalHmrReport = reload.report
					artifactGeneration.commit()
					await recovery.committed()
					state.application = application
					state.product = loaded.product
					state.configFiles = loaded.configFiles
					void logStaticRuntimeHmrUpdated(
						host,
						report,
						ctx.file,
						state.configFiles,
						roundHmrMs(performance.now() - start),
						viteInvalidation.count,
					).catch((error) => {
						host.ctx.logger.warn('HMR report failed', { error })
					})
					sendRequestedStaticRuntimeFullReload(ctx.server, host)
					return []
				})
			} catch (error) {
				preparedArtifacts?.rollback()
				artifactGeneration.rollback()
				const failure = await recovery.failed()
				if (!recentUpdates.hasUpdateSettlement()) {
					recentUpdates.recordDefinitions(
						evaluationTargets,
						{
							outcome: 'retained-previous',
							phase: recentUpdates.latestUpdate()?.phase === 'artifacts' ? 'artifacts' : 'commit',
							durationMs: elapsedStaticRuntimeUpdateMs(start),
						},
						{ scope: evaluationTargets.length > 0 ? 'definitions' : 'application' },
					)
				}
				recentUpdates.finishUpdate(describeUpdateError(error, server.config.root, failure?.imports))
				host?.ctx.logger.error('HMR candidate update failed; see update batch', {
					error,
					batch: recentUpdates.latestUpdate(),
				})
				throw error
			} finally {
				if (recentUpdates.hasUpdateSettlement()) recentUpdates.finishUpdate()
			}
		})
	}

	const routePlugin: Plugin = {
		name: 'pluxel:static-runtime',
		apply: 'serve',
		config(config) {
			return {
				...(workbenchClientEntry ? createWorkbenchViteClientConfig(workbenchClientEntry) : {}),
				...(config.cacheDir === undefined ? { cacheDir: STATIC_RUNTIME_CACHE_DIR } : {}),
			}
		},
		async configureServer(server) {
			const marked = server as ViteDevServer & { [STATIC_RUNTIME_SERVER_KEY]?: true }
			if (marked[STATIC_RUNTIME_SERVER_KEY]) {
				throw new Error('[runtime-static/vite] only one staticRuntimeVitePlugin is allowed')
			}
			marked[STATIC_RUNTIME_SERVER_KEY] = true
			installPluxelViteUrlPrinter(server, {
				publicOrigin: hostEnv.portlessOrigin,
				workbenchBasePath: () => {
					const activeHost = state.host
					return activeHost
						? requireRuntimeHttpService(activeHost.ctx).workbenchUiBasePath()
						: undefined
				},
			})
			state.server = server
			recovery.attach(server, (file, type) =>
				applyHotUpdate({
					file,
					type,
					server,
					timestamp: Date.now(),
					modules: [],
					read: async () => '',
				}),
			)
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
				const artifactGeneration = sourcePipeline.semantics.beginArtifactGeneration()
				try {
					await artifactGeneration.run(async () => {
						const loaded = await loadApplication(true)
						const startup = await replaceHost({
							application: loaded.application,
							product: loaded.product,
							configFiles: loaded.configFiles,
						})
						state.configFiles = loaded.configFiles
						const host = state.host!
						void logStaticRuntimeStarted(host, startup, state.configFiles).catch((error) => {
							host.ctx.logger.warn('HMR report failed', { error })
						})

						state.carrier = attachSrvxViteNodeCarrier(server, {
							transformViteHtml: Boolean(workbenchClientEntry),
							fetch(request) {
								const activeHost = state.host
								if (!activeHost) {
									return Promise.resolve(
										new Response('Static runtime is not ready', { status: 503 }),
									)
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
						artifactGeneration.commit()
					})
				} catch (error) {
					artifactGeneration.rollback()
					throw error
				}
				if (options.devConsole) {
					devConsole = await attachDevConsole({
						server,
						getHost: () =>
							state.host && { ctx: state.host.ctx.root, epoch: hostEpochs.get(state.host)! },
						prepare: async (_file, signal) => {
							const observed = hotUpdateTail
							await observed
							signal.throwIfAborted()
						},
					})
				}
			} catch (error) {
				state.applicationCarrier.stopAccepting()
				await devConsole?.close().catch((): undefined => undefined)
				await state.carrier?.close().catch((): undefined => undefined)
				state.carrier = undefined
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
			closing = true
			await recovery.close()
			let consoleError: unknown
			try {
				await devConsole?.close()
			} catch (error) {
				consoleError = error
			}
			devConsole = undefined
			await hotUpdateTail
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
			const errors = [consoleError, hostError, httpError, applicationCarrierError].filter(
				(error) => error !== undefined,
			)
			if (errors.length === 1) throw errors[0]
			if (errors.length > 1) {
				throw new AggregateError(errors, '[runtime-static/vite] carrier shutdown failed')
			}
		},
		async hotUpdate(ctx) {
			// Admit update/create/delete once in the owning SSR environment. Runtime
			// evaluation refreshes that graph itself; suppress further propagation of
			// handled modules so Vite cannot evict the newly committed constructors.
			if (
				this.environment.name === 'client' &&
				(state.configFiles.has(ctx.file) || recovery.matches(ctx.file))
			)
				return []
			if (this.environment.name !== 'ssr') return undefined
			return applyHotUpdate(ctx)
		},
	}

	return [
		recovery.plugin,
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
	startup: StaticRuntimeInternalStartupReport,
	configFiles: ReadonlySet<string>,
): Promise<void> {
	const summary = await formatStaticRuntimeReport(host, startup)
	host.ctx.logger.info('HMR report', formatStaticRuntimeHmrReport('startup', summary, configFiles))
}

async function logStaticRuntimeHmrUpdated(
	host: StaticRuntimeHost,
	report: StaticRuntimeInternalHmrReport,
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
	report: StaticRuntimeInternalStartupReport,
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
	report: StaticRuntimeInternalHmrReport,
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

function invalidateStaticRuntimeChangedModules(options: {
	server: ViteDevServer
	changedFile: string
	applicationFiles: ReadonlySet<string>
	changedModules: readonly EnvironmentModuleNode[]
	recoverMissingImports: boolean
}): Readonly<{ count: number; modules: ReadonlySet<string> }> {
	const { server, changedFile, applicationFiles, changedModules, recoverMissingImports } = options
	type ModuleLike = {
		id?: string
		file?: string | null
		importers?: Set<ModuleLike>
	}

	const queue: ModuleLike[] = [...changedModules]
	const seen = new Set<ModuleLike>()
	// The watcher path is the direct update authority. Keep it alongside graph IDs/files because
	// Vite may index a package-root module through its symlink while semantic transforms use the
	// physical file (or vice versa).
	const modules = new Set<string>([normalizePath(changedFile)])
	const graph = server.environments.ssr.moduleGraph
	for (const mod of graph.getModulesByFile(changedFile) ?? []) {
		queue.push(mod as ModuleLike)
	}
	// A missing file can sever importer edges before it is recreated. Retry the known
	// application closure on creation, or when a symlink/physical path lookup misses;
	// both cases must evict failed or stale importer evaluations as well as the file.
	if (queue.length === 0 || recoverMissingImports) {
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
		if (mod.id) modules.add(mod.id)
		if (mod.file) modules.add(normalizePath(mod.file))
		graph.invalidateModule(mod as Parameters<typeof graph.invalidateModule>[0])
		invalidated++
		for (const importer of mod.importers ?? []) queue.push(importer)
	}
	return { count: invalidated, modules }
}

function affectedStaticRuntimeDefinitions(
	host: StaticRuntimeHost | undefined,
	semantics: Pick<PluginSourceVitePipeline['semantics'], 'classifyDefinitionArtifact'>,
	invalidatedModules: Iterable<string>,
	wholeApplication: boolean,
): PluginDefinitionAddress[] {
	if (!host) return []
	const definitions = host.describeCatalog().plugins.map((entry) => entry.definition)
	return wholeApplication
		? definitions
		: definitions.filter(
				(definition) =>
					semantics.classifyDefinitionArtifact(definition, invalidatedModules) !== 'unreported',
			)
}

function staticViteExecution(
	artifact: 'source-module' | 'built-module' | 'unreported',
): PluginExecutionSnapshot {
	if (artifact === 'source-module') return STATIC_VITE_SOURCE_EXECUTION
	if (artifact === 'built-module') return STATIC_VITE_BUILT_EXECUTION
	return STATIC_VITE_UNREPORTED_EXECUTION
}

function elapsedStaticRuntimeUpdateMs(startedAt: number): number {
	return Math.max(0, performance.now() - startedAt)
}

function sendStaticRuntimeFullReload(server: ViteDevServer, host: StaticRuntimeHost): void {
	try {
		server.ws.send({ type: 'full-reload' })
	} catch (error) {
		host.ctx.logger.warn('HMR client reload notification failed', { error })
	}
}

function sendRequestedStaticRuntimeFullReload(
	server: ViteDevServer,
	host: StaticRuntimeHost,
): boolean {
	try {
		if (!requireRuntimeHttpService(host.ctx).consumeFullReloadRequest()) return false
		server.ws.send({ type: 'full-reload' })
		return true
	} catch (error) {
		host.ctx.logger.warn('HMR client reload notification failed', { error })
		return false
	}
}

function countStatuses(entries: readonly StaticRuntimeInternalStartupReport['entries'][number][]): {
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
): Promise<() => Promise<PreparedStaticArtifacts | undefined>> {
	const runtimeDev = await loadStaticRuntimeDevModule(server)
	const ctx = host.ctx
	if (!readRuntimeRouteCapabilities(ctx)) {
		throw new Error('[runtime-static/vite] static route capabilities must be registered first')
	}
	const compiler = runtimeDev.attachPluginArtifactCompiler(ctx, {
		packageMode: 'development',
		viteServer: server,
	})
	const prepare = async (): Promise<PreparedStaticArtifacts | undefined> => {
		if (!ctx.workbench) return undefined
		semantics.invalidateWorkbench()
		const [producers, content] = await Promise.all([
			semantics.workbenchCompilations(),
			semantics.workbenchContentCompilations(),
		])
		return await compiler.prepareWorkbenchArtifacts({ producers, content })
	}
	const initialArtifacts = await prepare()
	initialArtifacts?.commit()
	requireRuntimeHttpService(ctx).consumeFullReloadRequest()
	return prepare
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

interface PreparedStaticArtifacts {
	commit(): unknown
	rollback(): void
}

function portableUpdatePath(file: string, root: string): string {
	const clean = normalizePath(file).split('?')[0]!
	if (!isAbsolute(clean)) return clean.slice(0, 1024)
	const local = normalizePath(relative(root, clean))
	return (local.startsWith('../') ? clean.split('/').slice(-2).join('/') : local).slice(0, 1024)
}

function describeUpdateError(
	error: unknown,
	root: string,
	imports: readonly { importer: string; source: string; resolved?: string; failed: boolean }[] = [],
) {
	const chain: string[] = []
	const messages: string[] = []
	const seen = new Set<unknown>()
	let file: string | null = null
	let current = error
	while (current && typeof current === 'object' && !seen.has(current) && seen.size < 8) {
		seen.add(current)
		const value = current as {
			message?: unknown
			id?: unknown
			file?: unknown
			importer?: unknown
			cause?: unknown
			stack?: unknown
		}
		if (typeof value.message === 'string') messages.push(value.message)
		const stackFiles =
			typeof value.stack === 'string'
				? [...value.stack.matchAll(/(?:file:\/\/)?(\/[^()\n]+?):\d+:\d+/g)].map(
						(match) => match[1]!,
					)
				: []
		const source =
			typeof value.id === 'string'
				? value.id
				: typeof value.file === 'string'
					? value.file
					: (stackFiles.find((path) => imports.some((entry) => entry.resolved === path)) ?? null)
		if (source) {
			file ??= portableUpdatePath(source, root)
			chain.push(portableUpdatePath(source, root))
		}
		if (typeof value.importer === 'string') chain.push(portableUpdatePath(value.importer, root))
		current = value.cause
	}
	const failedImport =
		imports.find(
			(entry) => file && entry.resolved && portableUpdatePath(entry.resolved, root) === file,
		) ?? imports.find((entry) => entry.failed)
	if (failedImport) {
		file ??= portableUpdatePath(failedImport.resolved ?? failedImport.source, root)
		let importer: string | undefined = failedImport.importer
		const visited = new Set<string>()
		while (importer && !visited.has(importer) && visited.size < 24) {
			visited.add(importer)
			chain.unshift(portableUpdatePath(importer, root))
			importer = imports.find((entry) => entry.resolved === importer)?.importer
		}
		chain.push(file)
	}
	const message = (messages.length > 0 ? [...new Set(messages)].join(' — ') : String(error))
		.replaceAll(normalizePath(root) + '/', '')
		.replaceAll(/(?:[A-Za-z]:)?\/(?:[^\s'"()<>:]+\/)+[^\s'"()<>:]*/g, (path) =>
			portableUpdatePath(path, root),
		)
		.slice(0, 4096)
	return { message, file, importChain: [...new Set(chain)].slice(0, 32) }
}
