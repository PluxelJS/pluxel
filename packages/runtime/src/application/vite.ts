import { portableUpdatePath, describeUpdateError } from '@pluxel/host-dev/internal/update-error'
import { resolveDevWorkbenchClientEntryUrl } from '@pluxel/workbench/internal/shell'
import { optionalWorkbench } from '@pluxel/workbench/server'
import { createHostDevelopmentDriver } from '@pluxel/host-dev'
import { installPluginSources } from '@pluxel/host/internal'
import {
	attachSrvxViteNodeCarrier,
	createViteNodeElysiaApplicationCarrier,
	type SrvxViteNodeCarrierAttachment,
} from '@pluxel/host-dev/internal/vite-node-carrier'
import { installPluxelViteUrlPrinter } from '../development/vite-urls.ts'
import { createWorkbenchViteClientConfig } from '../development/vite-client.ts'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { env as runtimeEnvironment, hostEnv } from '../environment.ts'
import {
	collectViteSsrImportFiles,
	createHostSourceEvaluator,
	type HostSourceCandidate,
	beginHostCandidate,
	invalidateHostChangedModules,
	ViteApplicationRecovery,
	createHostModuleVitePlugin,
	hostSingletons,
	importViteSsrModule,
	invalidateViteSsrModule,
} from '@pluxel/host-dev/vite'
import {
	attachDevConsole,
	type DevConsoleAttachment,
} from '@pluxel/host-dev/internal/console/attachment'
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
} from '@pluxel/host-dev/hmr-log'
import { shouldHandleRuntimeViteRequest } from '../development/vite-route-request.ts'
import {
	readHostProduct,
	readRuntimePluginStatusOverview,
	readRuntimeRouteCapabilities,
	requireRuntimeHttpService,
	sameProduct,
	type PluginExecutionSnapshot,
} from '../internal.ts'
import { createWorkbenchBackend } from '../internal-static.ts'
import type { ProductDescriptor } from '../product.ts'
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

import { isRuntimeApplication, resolveRuntimeHostOptions } from './application.ts'
import { toRuntimeDefinition } from './internal/application.ts'
import { createRuntimeHost, type RuntimeHostImpl } from './internal/host.ts'
import { RuntimeRecentUpdateTracker } from './internal/recent-update.ts'
import type {
	RuntimeApplication,
	RuntimeBindings,
	RuntimeDefinition,
	RuntimeHost,
	RuntimeInternalHmrReport,
	RuntimeInternalStartupReport,
	RuntimeStartupContext,
} from './types.ts'

const STATIC_RUNTIME_SERVER_KEY = Symbol.for('pluxel.runtimeVitePlugin')
const STATIC_RUNTIME_CACHE_DIR = '.pluxel/vite/runtime-v2'
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

export type RuntimeVitePluginOptions = {
	/** Enable trusted local TypeScript operations on the current dev host. @default false */
	devConsole?: boolean
	entry: string
	root?: string
	bindings?: RuntimeBindings | (() => RuntimeBindings | Promise<RuntimeBindings>)
}

export function runtime(options: RuntimeVitePluginOptions): PluginOption[] {
	if (options.devConsole !== undefined && typeof options.devConsole !== 'boolean') {
		throw new TypeError('[runtime/vite] devConsole must be a boolean')
	}
	const hostEpochs = new WeakMap<RuntimeHostImpl, string>()
	let devConsole: DevConsoleAttachment | undefined
	let closing = false
	const workbenchClientEntry = resolveDevWorkbenchClientEntryUrl()
	const sourcePipeline = createPluginSourceVitePipeline({
		name: 'pluxel:runtime-source',
		preset: 'runtime',
	})
	const artifactPreparers = new WeakMap<
		RuntimeHost,
		() => Promise<PreparedStaticArtifacts | undefined>
	>()
	const activeModulesByHost = new WeakMap<RuntimeHostImpl, { current: ReadonlySet<string> }>()
	const recentUpdates = new RuntimeRecentUpdateTracker()
	const recovery = new ViteApplicationRecovery()
	const state: {
		server?: ViteDevServer
		entryPath?: string
		configFiles: Set<string>
		application?: RuntimeApplication
		product?: ProductDescriptor | null
		host?: RuntimeHostImpl
		carrier?: SrvxViteNodeCarrierAttachment
		applicationCarrier?: StaticViteApplicationCarrier
		detachApplicationCarrier?: () => void
	} = {
		configFiles: new Set(),
	}
	const driver = createHostDevelopmentDriver()
	const enqueueHotUpdate = driver.enqueue

	let sourceEvaluator: ReturnType<typeof createHostSourceEvaluator> | undefined
	let sourceFiles: ReadonlySet<string> = new Set()
	let sourceModules: ReadonlySet<string> = new Set()
	const sourceRoot = () =>
		options.root
			? resolve(state.server!.config.root, options.root)
			: applicationRoot(state.entryPath!)
	const reportSourceError = (error: unknown): void => {
		if (state.host) state.host.ctx.logger.error('Plugin source update failed', { error })
		else {
			const reportedError =
				error instanceof Error ? error : new Error('Plugin source update failed', { cause: error })
			state.server?.config.logger.error('Plugin source update failed', { error: reportedError })
		}
	}
	const acceptSources = async (
		candidate: HostSourceCandidate<RuntimeApplication>,
	): Promise<void> => {
		sourceFiles = candidate.sourceFiles
		sourceModules = candidate.sourceModules
		await candidate.accept()
	}

	const acceptCandidate = async (
		candidate: ReturnType<typeof beginHostCandidate>,
		sources: HostSourceCandidate<RuntimeApplication>,
	): Promise<void> => {
		const errors: unknown[] = []
		try {
			await candidate.accept()
		} catch (error) {
			errors.push(error)
		}
		try {
			await acceptSources(sources)
		} catch (error) {
			errors.push(error)
		}
		if (errors.length > 0)
			throw new AggregateError(errors, '[runtime/vite] accepted candidate cleanup failed')
	}

	const loadApplication = async (
		fresh: boolean,
	): Promise<{
		application: RuntimeApplication
		product: ProductDescriptor | null
		configFiles: Set<string>
		sourceCandidate: HostSourceCandidate<RuntimeApplication>
	}> => {
		const server = state.server
		if (!server) throw new Error('[runtime/vite] Vite server is not configured')
		const entryPath = (state.entryPath ??= resolveRuntimeEntryPath(
			server,
			options.entry,
			'runtime',
		))
		if (fresh) invalidateViteSsrModule(server, entryPath)
		const mod = await importViteSsrModule(server, entryPath)
		const application = validateRuntimeApplicationModule(mod, entryPath)
		sourceEvaluator ??= createHostSourceEvaluator({
			server,
			root: sourceRoot(),
			onError: reportSourceError,
			onChange(change) {
				if (closing) return
				void applyHotUpdate(
					{
						file: change.path,
						type: change.type === 'add' ? 'create' : change.type === 'unlink' ? 'delete' : 'update',
						server,
						timestamp: Date.now(),
						modules: [],
						read: async () => '',
					},
					true,
				).catch(reportSourceError)
			},
		})
		const sourceCandidate = await sourceEvaluator.evaluate({
			application,
			entryFiles: collectViteSsrImportFiles(server, entryPath),
		})
		try {
			return {
				application: sourceCandidate.application,
				product: readHostProduct(mod, `[runtime/vite] ${entryPath}`),
				configFiles: sourceCandidate.files,
				sourceCandidate,
			}
		} catch (error) {
			await sourceCandidate.reject()
			throw error
		}
	}

	const createHost = async (
		application: RuntimeApplication,
		product: ProductDescriptor | null,
		configFiles: ReadonlySet<string>,
		resolveExecution?: StaticViteExecutionResolver,
	): Promise<RuntimeHostImpl> => {
		const server = state.server
		if (!server) throw new Error('[runtime/vite] Vite server is not configured')
		const startup: RuntimeStartupContext = {
			root: options.root
				? resolve(server.config.root, options.root)
				: applicationRoot(state.entryPath!),
			mode: 'development',
			env: runtimeEnvironment,
			bindings: await resolveViteBindings(options.bindings),
		}
		const config = await resolveRuntimeHostOptions(application, startup, {
			workbench: true,
		})
		const activeModules = { current: new Set(configFiles) as ReadonlySet<string> }
		const host = await createRuntimeHost(toRuntimeDefinition(application), config, {
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
		installPluginSources(host.ctx, { root: startup.root, sources: application.sources ?? [] })
		hostEpochs.set(host, randomUUID())
		activeModulesByHost.set(host, activeModules)
		try {
			const prepareArtifacts = await configureRuntimeDevRuntime(
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
		application: RuntimeApplication
		product: ProductDescriptor | null
		configFiles: ReadonlySet<string>
		updateStartedAt?: number
	}): Promise<RuntimeInternalStartupReport> {
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

		let next: RuntimeHostImpl | undefined
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
			if (closing) throw new Error('[runtime/vite] host replacement cancelled by shutdown')
			next = await createHost(application, product, configFiles)
			if (closing) throw new Error('[runtime/vite] host replacement cancelled by shutdown')
			const applicationCarrier = state.applicationCarrier
			if (!applicationCarrier) {
				throw new Error('[runtime/vite] Elysia application carrier is not configured')
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
								durationMs: elapsedRuntimeUpdateMs(updateStartedAt),
							}
						: {
								outcome: 'applied',
								phase: null,
								durationMs: elapsedRuntimeUpdateMs(updateStartedAt),
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
			if (!closing && previousHost && previousApplication) {
				let restored: RuntimeHostImpl | undefined
				try {
					restored = await createHost(
						previousApplication,
						previousProduct,
						previousConfigFiles,
						restoreExecution,
					)
					const applicationCarrier = state.applicationCarrier
					if (!applicationCarrier) {
						throw new Error('[runtime/vite] Elysia application carrier is not configured', {
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
								durationMs: elapsedRuntimeUpdateMs(updateStartedAt),
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
						'[runtime/vite] host replacement and rollback both failed',
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

	const applyHotUpdate = (
		ctx: HotUpdateOptions,
		sourceChange = false,
	): Promise<EnvironmentModuleNode[] | void> => {
		if (closing) return Promise.resolve(undefined)
		devConsole?.invalidate(ctx.file)
		devConsole?.observed(ctx.file)
		return enqueueHotUpdate(async (): Promise<EnvironmentModuleNode[] | void> => {
			if (closing) return undefined
			const host = state.host
			if (!sourceChange && !state.configFiles.has(ctx.file) && !recovery.matches(ctx.file)) {
				const prepare = host ? artifactPreparers.get(host) : undefined
				if (!prepare || !host || !optionalWorkbench(host.ctx)) return undefined
				const start = performance.now()
				recentUpdates.beginUpdate(portableUpdatePath(ctx.file, ctx.server.config.root))
				recentUpdates.updatePhase('artifacts')
				try {
					const prepared = await prepare()
					if (closing) {
						prepared?.rollback()
						return undefined
					}
					prepared?.commit()
					recentUpdates.recordDefinitions(
						[],
						{ outcome: 'applied', phase: null, durationMs: elapsedRuntimeUpdateMs(start) },
						{ scope: 'application' },
					)
					recentUpdates.finishUpdate()
				} catch (error) {
					recentUpdates.recordDefinitions(
						[],
						{
							outcome: 'retained-previous',
							phase: 'artifacts',
							durationMs: elapsedRuntimeUpdateMs(start),
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
				if (host && sendRequestedRuntimeFullReload(ctx.server, host)) return []
				return undefined
			}
			const server = state.server ?? ctx.server
			state.server = server
			const start = performance.now()
			const viteInvalidation = invalidateHostChangedModules({
				server,
				changedFile: ctx.file,
				applicationFiles: recovery.invalidationFiles(state.configFiles),
				changedModules: ctx.modules,
				recoverMissingImports:
					recovery.matches(ctx.file) ||
					(ctx.type === 'create' && !sourceChange && !sourceEvaluator?.covers(ctx.file)),
				reloadDependencies: sourceChange || sourceEvaluator?.covers(ctx.file),
			})
			const evaluationTargets = affectedRuntimeDefinitions(
				host,
				sourcePipeline.semantics,
				viteInvalidation.modules,
				ctx.file === state.entryPath,
			)
			// A failed import can lose its file identity in the runner. Invalidate the
			// known importer closure as well so recreating that file retries evaluation.
			for (const module of viteInvalidation.modules) invalidateViteSsrModule(server, module)
			// Normal edits preserve unrelated Plugin constructors; recreated imports use the recovery closure.
			const candidate = beginHostCandidate({
				entry: state.entryPath!,
				semantics: sourcePipeline.semantics,
				recovery,
			})
			recentUpdates.beginUpdate(portableUpdatePath(ctx.file, server.config.root))
			let preparedArtifacts: PreparedStaticArtifacts | undefined
			let stagedSources: HostSourceCandidate<RuntimeApplication> | undefined
			try {
				return await candidate.run(async (): Promise<EnvironmentModuleNode[] | void> => {
					let loaded: Awaited<ReturnType<typeof loadApplication>>
					try {
						loaded = await loadApplication(true)
						stagedSources = loaded.sourceCandidate
					} catch (error) {
						await candidate.reject()
						// Vite reports an unlink to watchChange before this hook. That removes the
						// deleted module's semantic facts, so an evaluation failure can leave no exact
						// targets even though the previous static catalog is still authoritative.
						recentUpdates.recordDefinitions(
							evaluationTargets,
							{
								outcome: 'retained-previous',
								phase: 'evaluate',
								durationMs: elapsedRuntimeUpdateMs(start),
							},
							{ scope: evaluationTargets.length > 0 ? 'definitions' : 'application' },
						)
						throw error
					}
					if (closing) {
						await loaded.sourceCandidate.reject()
						await candidate.reject()
						return []
					}
					const application = loaded.application
					const productChanged = !sameProduct(state.product ?? null, loaded.product)
					if (
						!host ||
						ctx.file === state.entryPath ||
						application.name !== host.definition.name ||
						productChanged ||
						loaded.sourceCandidate.declarationsChanged ||
						(!hasCatalogChanges(host.definition, application) &&
							!sourceChange &&
							!sourceFiles.has(ctx.file) &&
							!sourceModules.has(ctx.file))
					) {
						let startup: RuntimeInternalStartupReport
						try {
							recentUpdates.updatePhase('application-reload')
							startup = await replaceHost({
								application,
								product: loaded.product,
								configFiles: loaded.configFiles,
								updateStartedAt: start,
							})
						} catch (error) {
							await candidate.reject()
							throw error
						}
						await acceptCandidate(candidate, loaded.sourceCandidate)
						state.configFiles = loaded.configFiles
						const replacementHost = state.host!
						void logRuntimeStarted(replacementHost, startup, state.configFiles).catch((error) => {
							replacementHost.ctx.logger.warn('HMR report failed', { error })
						})
						if (productChanged) sendRuntimeFullReload(ctx.server, replacementHost)
						return []
					}
					try {
						recentUpdates.updatePhase('artifacts')
						preparedArtifacts = await artifactPreparers.get(host)?.()
					} catch (error) {
						await candidate.reject()
						throw error
					}
					if (closing) {
						preparedArtifacts?.rollback()
						await loaded.sourceCandidate.reject()
						await candidate.reject()
						return []
					}
					const activeModules = activeModulesByHost.get(host)
					if (!activeModules) {
						await candidate.reject()
						throw new Error('[runtime/vite] active application module closure is unavailable')
					}
					const previousActiveModules = activeModules.current
					activeModules.current = new Set(loaded.configFiles)
					recentUpdates.updatePhase('commit')
					const reload = await host.applyDefinitionUpdate(toRuntimeDefinition(application), start, {
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
							await acceptCandidate(candidate, loaded.sourceCandidate)
						} else {
							activeModules.current = previousActiveModules
							await candidate.reject()
						}
						throw reload.error
					}
					const report: RuntimeInternalHmrReport = reload.report
					state.application = application
					state.product = loaded.product
					state.configFiles = loaded.configFiles
					await acceptCandidate(candidate, loaded.sourceCandidate)
					void logRuntimeHmrUpdated(
						host,
						report,
						ctx.file,
						state.configFiles,
						roundHmrMs(performance.now() - start),
						viteInvalidation.count,
					).catch((error) => {
						host.ctx.logger.warn('HMR report failed', { error })
					})
					sendRequestedRuntimeFullReload(ctx.server, host)
					return []
				})
			} catch (error) {
				preparedArtifacts?.rollback()
				await candidate.reject()
				await stagedSources?.reject()
				const failure = await candidate.reject()
				if (!recentUpdates.hasUpdateSettlement()) {
					recentUpdates.recordDefinitions(
						evaluationTargets,
						{
							outcome: 'retained-previous',
							phase: recentUpdates.latestUpdate()?.phase === 'artifacts' ? 'artifacts' : 'commit',
							durationMs: elapsedRuntimeUpdateMs(start),
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
		name: 'pluxel:runtime',
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
				throw new Error('[runtime/vite] only one runtimeVitePlugin is allowed')
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
				const candidate = beginHostCandidate({
					entry: state.entryPath ?? resolveRuntimeEntryPath(server, options.entry, 'runtime'),
					semantics: sourcePipeline.semantics,
					recovery,
				})
				let stagedSources: HostSourceCandidate<RuntimeApplication> | undefined
				try {
					await enqueueHotUpdate(() =>
						candidate.run(async () => {
							const loaded = await loadApplication(true)
							stagedSources = loaded.sourceCandidate
							const startup = await replaceHost({
								application: loaded.application,
								product: loaded.product,
								configFiles: loaded.configFiles,
							})
							state.configFiles = loaded.configFiles
							const host = state.host!
							void logRuntimeStarted(host, startup, state.configFiles).catch((error) => {
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
									return Boolean(activeHost && isRuntimeRouteRequest(request, activeHost))
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
							await acceptCandidate(candidate, loaded.sourceCandidate)
						}),
					)
				} catch (error) {
					await candidate.reject()
					await stagedSources?.reject()
					throw error
				}
				if (options.devConsole) {
					devConsole = await attachDevConsole({
						server,
						getHost: () =>
							state.host && {
								ctx: state.host.ctx.root,
								epoch: hostEpochs.get(state.host)!,
								fetch: state.host.fetch.bind(state.host),
							},
						prepare: async (_file, signal) => {
							const observed = driver.settled()
							await observed
							signal.throwIfAborted()
						},
					})
				}
			} catch (error) {
				closing = true
				await sourceEvaluator?.close().catch(reportSourceError)
				await driver.close().catch(reportSourceError)
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
			const earlyErrors: unknown[] = []
			try {
				await sourceEvaluator?.close()
			} catch (error) {
				earlyErrors.push(error)
			}
			try {
				await recovery.close()
			} catch (error) {
				earlyErrors.push(error)
			}
			let consoleError: unknown
			try {
				await devConsole?.close()
			} catch (error) {
				consoleError = error
			}
			devConsole = undefined
			try {
				await driver.close()
			} catch (error) {
				earlyErrors.push(error)
			}
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
			const errors = [
				...earlyErrors,
				consoleError,
				hostError,
				httpError,
				applicationCarrierError,
			].filter((error) => error !== undefined)
			if (errors.length === 1) throw errors[0]
			if (errors.length > 1) {
				throw new AggregateError(errors, '[runtime/vite] carrier shutdown failed')
			}
		},
		async hotUpdate(ctx) {
			if (sourceEvaluator?.covers(ctx.file)) return []
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
		hostSingletons(),
		recovery.plugin,
		staticConfigEnvironmentVitePlugin({ entry: options.entry }),
		...sourcePipeline.plugins,
		createHostModuleVitePlugin(),
		routePlugin,
	]
}

type RuntimeReportSummary = {
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

async function logRuntimeStarted(
	host: RuntimeHost,
	startup: RuntimeInternalStartupReport,
	configFiles: ReadonlySet<string>,
): Promise<void> {
	const summary = await formatRuntimeReport(host, startup)
	host.ctx.logger.info('HMR report', formatRuntimeHmrReport('startup', summary, configFiles))
}

async function logRuntimeHmrUpdated(
	host: RuntimeHost,
	report: RuntimeInternalHmrReport,
	changedFile: string,
	configFiles: ReadonlySet<string>,
	commitMs: number,
	viteInvalidated: number,
): Promise<void> {
	const summary = await formatRuntimeReport(host, report)
	const ok = report.commit?.lifecycleReport.ok ?? false
	const props = {
		ok,
		changedFiles: 1,
		...hmrChangedPreviewProps(
			hmrPathPreview([changedFile], { limit: HMR_PATH_PREVIEW_LIMIT, normalize: normalizePath }),
			HMR_PATH_PREVIEW_LIMIT,
		),
		targets: summary.plugins.catalog,
		affected: affectedRuntimePlugins(host, report),
		activeServices: summary.plugins.running,
		fallbackRoots: configFiles.size,
		plugins: toHmrPluginTotals(summary),
		invalidated: hmrInvalidated(viteInvalidated),
		commitMs,
		...(ok ? {} : { commitError: 'static runtime reload did not produce a successful commit' }),
	} satisfies HmrUpdatedLogProps
	host.ctx.logger[ok ? 'info' : 'warn']('HMR updated', props)
	host.ctx.logger.info('HMR report', formatRuntimeHmrReport('update', summary, configFiles))
}

async function formatRuntimeReport(
	host: RuntimeHost,
	report: RuntimeInternalStartupReport,
): Promise<RuntimeReportSummary> {
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

function formatRuntimeHmrReport(
	reason: 'startup' | 'update',
	summary: RuntimeReportSummary,
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

function toHmrPluginTotals(summary: RuntimeReportSummary): HmrPluginTotals {
	return {
		loaded: summary.plugins.catalog,
		desired: summary.plugins.desired,
		running: summary.plugins.running,
	}
}

function affectedRuntimePlugins(host: RuntimeHost, report: RuntimeInternalHmrReport): number {
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

function affectedRuntimeDefinitions(
	host: RuntimeHost | undefined,
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

function elapsedRuntimeUpdateMs(startedAt: number): number {
	return Math.max(0, performance.now() - startedAt)
}

function sendRuntimeFullReload(server: ViteDevServer, host: RuntimeHost): void {
	try {
		server.ws.send({ type: 'full-reload' })
	} catch (error) {
		host.ctx.logger.warn('HMR client reload notification failed', { error })
	}
}

function sendRequestedRuntimeFullReload(server: ViteDevServer, host: RuntimeHost): boolean {
	try {
		if (!requireRuntimeHttpService(host.ctx).consumeFullReloadRequest()) return false
		server.ws.send({ type: 'full-reload' })
		return true
	} catch (error) {
		host.ctx.logger.warn('HMR client reload notification failed', { error })
		return false
	}
}

function countStatuses(entries: readonly RuntimeInternalStartupReport['entries'][number][]): {
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

function validateRuntimeApplicationModule(
	mod: Record<string, unknown>,
	entryPath: string,
): RuntimeApplication {
	const value = mod.default
	if (value && typeof (value as Promise<unknown>).then === 'function') {
		throw new Error(
			`[runtime/vite] ${entryPath} default export must be an application object, not a Promise`,
		)
	}
	if (!isRuntimeApplication(value)) {
		throw new Error(`[runtime/vite] ${entryPath} must default-export an application object`)
	}
	return value
}

function hasCatalogChanges(
	current: RuntimeDefinition,
	next: Pick<RuntimeApplication, 'plugins'>,
): boolean {
	if (current.plugins.length !== next.plugins.length) return true
	return current.plugins.some((plugin, index) => plugin !== next.plugins[index])
}

async function resolveViteBindings(
	bindings: RuntimeVitePluginOptions['bindings'],
): Promise<RuntimeBindings> {
	if (typeof bindings === 'function') return (await bindings()) ?? {}
	return bindings ?? {}
}

async function configureRuntimeDevRuntime(
	server: ViteDevServer,
	host: RuntimeHost,
	semantics: Pick<
		PluginSourceVitePipeline['semantics'],
		'invalidateWorkbench' | 'workbenchCompilations' | 'workbenchContentCompilations'
	>,
): Promise<() => Promise<PreparedStaticArtifacts | undefined>> {
	const runtimeDev = await loadRuntimeDevModule(server)
	const ctx = host.ctx
	if (!readRuntimeRouteCapabilities(ctx)) {
		throw new Error('[runtime/vite] static route capabilities must be registered first')
	}
	const compiler = runtimeDev.attachPluginArtifactCompiler(ctx, {
		packageMode: 'development',
		viteServer: server,
	})
	const prepare = async (): Promise<PreparedStaticArtifacts | undefined> => {
		if (!optionalWorkbench(ctx)) return undefined
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

async function loadRuntimeDevModule(_server: ViteDevServer) {
	return import('../development/workbench.ts')
}

function isRuntimeRouteRequest(request: IncomingMessage, host: Pick<RuntimeHost, 'ctx'>): boolean {
	const url = request.url ?? '/'
	const workbenchEnabled = optionalWorkbench(host.ctx) !== undefined
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

function applicationRoot(entry: string): string {
	let directory = dirname(entry)
	while (!existsSync(resolve(directory, 'package.json'))) {
		const parent = dirname(directory)
		if (parent === directory) return dirname(entry)
		directory = parent
	}
	return directory
}
