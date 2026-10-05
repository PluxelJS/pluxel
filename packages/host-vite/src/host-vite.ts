import { hostViteProfile, type HostViteProfile } from './profile'
import { installHostViteShutdown } from './internal/host-session'
import { createHostDependencyWatch } from './dependency-watch'
import { createHostModuleBytes } from './module-bytes'
import { checkDevelopmentWorkspace } from './workspace-setup'
import {
	pluginDefinitionAddressOf,
	pluginDefinitionIndexKey,
	type PluginConstructor,
} from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { randomUUID } from 'node:crypto'
import type { DevConsoleAttachment } from './console/attachment'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
	createHost,
	resolveHostApplication,
	prepareHostApplication,
	type HostApplicationFactory,
	type ResolvedHostApplication,
	type PluginHost,
	type PluginApplyReport,
} from '@pluxel/host'
import {
	updateHostCatalog,
	installPluginSources,
	setHostCatalogProvenance,
	installedPackageFacts,
	recordLoadedPluginModule,
	readLoadedPluginModule,
	resolveNativeImport,
	readLoadedHostApplicationModule,
	type PluginCatalogProvenance,
	installHostRecentUpdates,
	PluginRecentUpdateTracker,
} from '@pluxel/host/internal'
import {
	type PluginExecutionSnapshot,
	type PluginUpdateBatchSnapshot,
	type RuntimeUpdateError,
} from '@pluxel/host/internal/protocol'
import {
	portableUpdatePath,
	describeUpdateError,
	createViteDiagnostics,
	createHostDiagnostics,
} from './internal/update-error'
import { createPluginSourceVitePipeline } from '@pluxel/rolldown/vite'
import { normalizePath, type Plugin, type PluginOption, type ViteDevServer } from 'vite'
import { createHostViteDriver, HostViteClosedError } from './driver'
import { beginHostCandidate } from './candidate'
import { createHostSourceEvaluator, type HostSourceCandidate } from './application-sources'
import { ViteApplicationRecovery } from './internal/vite-application-recovery'
import { invalidateHostChangedModules } from './invalidation'
import {
	isHostNativeModule,
	collectHostImportFiles,
	importHostModule,
	invalidateHostModule,
	hostEnvironment,
	HOST_VITE_ENVIRONMENT,
} from './environment'
import { hostSingletons } from './singletons'
import { attachHostVitePlugins, type HostViteCandidate, type HostViteCatalog } from './attachments'

export type HostViteOptions = Readonly<{
	/** Application module default-exporting defineHostApplication(factory). Relative to Vite root. */
	entry: string
	/** Enable the local TypeScript console. @default false */
	devConsole?: boolean
	/** Shallow immutable startup bindings shared by the application factory and prepare; omitted means an empty record. */
	bindings?: Readonly<Record<string, unknown>>
}>

/** Host Vite assembly owning one runner, source evaluator and candidate protocol. */
export function host(options: HostViteOptions): PluginOption[] {
	for (const key of Object.keys(options))
		if (!['entry', 'devConsole', 'bindings'].includes(key))
			throw new TypeError(`[host-vite] unsupported ${key}`)
	const { entry: inputEntry, devConsole: enableDevConsole, bindings: inputBindings } = options
	if (typeof inputEntry !== 'string' || !inputEntry.trim())
		throw new TypeError('[host-vite] entry is required')
	if (enableDevConsole !== undefined && typeof enableDevConsole !== 'boolean')
		throw new TypeError('[host-vite] devConsole must be a boolean')
	if (
		inputBindings !== undefined &&
		(!inputBindings ||
			typeof inputBindings !== 'object' ||
			(Object.getPrototypeOf(inputBindings) !== Object.prototype &&
				Object.getPrototypeOf(inputBindings) !== null))
	)
		throw new TypeError('[host-vite] bindings must be a plain record')
	const bindings = Object.freeze({ ...inputBindings })
	const moduleBytes = createHostModuleBytes()
	let profile: HostViteProfile = 'development'
	const pipeline = createPluginSourceVitePipeline({
		environment: HOST_VITE_ENVIRONMENT,
		get packageMode() {
			return profile === 'production' ? 'distribution' : 'development'
		},
	})
	const driver = createHostViteDriver()
	const recentUpdates = new PluginRecentUpdateTracker()
	let server: ViteDevServer
	let entry: string
	let sources: ReturnType<typeof createHostSourceEvaluator>
	let active: PluginHost | undefined
	let application: ResolvedHostApplication | undefined
	let applicationFactory: HostApplicationFactory | undefined
	let fixedApplication: ResolvedHostApplication | undefined
	let provenance = new Map<PluginConstructor, PluginCatalogProvenance>()
	let files = new Set<string>()
	let acceptedCatalog: HostViteCatalog | undefined
	let closing = false
	let shutdown: Promise<void> | undefined
	let devConsole: DevConsoleAttachment | undefined
	let dependencies: ReturnType<typeof createHostDependencyWatch> | undefined
	const epochs = new WeakMap<PluginHost, string>()
	const attachments = new WeakMap<PluginHost, Awaited<ReturnType<typeof attachHostVitePlugins>>>()
	const diagnostics = createHostDiagnostics(
		() => (closing ? undefined : active?.ctx.logger),
		createViteDiagnostics(() => server.config.logger),
	)
	const recovery = new ViteApplicationRecovery(diagnostics)
	const report = (error: unknown): void => {
		diagnostics.error('Vite Host update failed', { error })
	}
	const create = async (
		declaration: ResolvedHostApplication,
		facts: ReadonlyMap<PluginConstructor, PluginCatalogProvenance>,
		catalog: HostViteCatalog,
	): Promise<PluginHost> => {
		const instance = await createHost({
			plugins: declaration.plugins,
			config: declaration.config,
			state: declaration.state,
			configRecords: declaration.configRecords,
			vaultBindings: declaration.vaultBindings,
			services: declaration.services,
		})
		try {
			setHostCatalogProvenance(instance.ctx, facts)
			installHostRecentUpdates(instance.ctx, recentUpdates)
			installPluginSources(instance.ctx, {
				root: server.config.root,
				sources: declaration.sources ?? [],
				updates: 'live',
			})
			attachments.set(
				instance,
				await attachHostVitePlugins(instance, server, pipeline.semantics, catalog, profile),
			)
			await prepareHostApplication(declaration, instance)
			epochs.set(instance, randomUUID())
			return instance
		} catch (error) {
			throw await closeFailedHost(instance, error)
		}
	}
	const apply = async (changed?: {
		file: string
		type: 'create' | 'update' | 'delete'
	}): Promise<void> => {
		if (closing) return
		if (
			changed &&
			dependencies?.covers(changed.file) &&
			!recovery.matches(changed.file) &&
			(await moduleBytes.unchanged(changed.file))
		)
			return
		if (changed) {
			const changedDependencies = sources.covers(changed.file)
				? await moduleBytes.changed(collectHostImportFiles(server, changed.file))
				: []
			const invalidation = invalidateHostChangedModules({
				server,
				changedFile: changed.file,
				applicationFiles: recovery.invalidationFiles(files),
				changedModules: [],
				changedDependencies,
				recoverMissingImports:
					recovery.requiresResolutionRetry(changed.file) ||
					(changed.type === 'create' && !sources.covers(changed.file)),
				reloadDependencies: sources.covers(changed.file),
			})
			for (const file of invalidation.modules) invalidateHostModule(server, file)
		}
		const candidate = beginHostCandidate({ entry, semantics: pipeline.semantics, recovery })
		let sourceCandidate: HostSourceCandidate<ResolvedHostApplication> | undefined
		let nextProvenance = provenance
		let nextCatalog: HostViteCatalog | undefined
		let accepted = false
		let restored = false
		let replacement = false
		let compensation: ResolvedHostApplication | undefined
		let nextFactory: HostApplicationFactory | undefined
		let nextFixed: ResolvedHostApplication | undefined
		let lifecycle: PluginApplyReport | undefined
		let updateError: RuntimeUpdateError | null = null
		const started = performance.now()
		const previousCatalog = active?.catalog()
		recentUpdates.beginUpdate(changed ? portableUpdatePath(changed.file, server.config.root) : null)
		let artifactCandidate: HostViteCandidate | undefined
		const settle = async (accept: boolean): Promise<void> => {
			const results = await Promise.allSettled([
				Promise.resolve().then(() =>
					accept ? artifactCandidate?.commit() : artifactCandidate?.rollback(),
				),
				accept ? sourceCandidate?.accept() : sourceCandidate?.reject(),
				accept ? candidate.accept() : candidate.reject(),
			])
			const errors = results.flatMap((result) =>
				result.status === 'rejected' ? [result.reason] : [],
			)
			if (errors.length > 0)
				throw new AggregateError(errors, '[host-vite] candidate settlement failed')
		}
		try {
			await candidate.run(async () => {
				const namespace = await importHostModule<Record<string, unknown>>(server, entry)
				if (typeof namespace.default !== 'function')
					throw new TypeError(
						'[host-vite] Application must default-export defineHostApplication(factory)',
					)
				nextFactory = namespace.default as HostApplicationFactory
				// Source-only changes reuse this Host's startup snapshot and fixed assembly.
				// A re-evaluated application factory is a new assembly, including its closures.
				const declared =
					active && nextFactory === applicationFactory && fixedApplication
						? fixedApplication
						: await resolveHostApplication(nextFactory, {
								root: server.config.root,
								mode: profile,
								env: { ...process.env, NODE_ENV: profile },
								bindings,
							})
				nextFixed = declared
				sourceCandidate = await sources.evaluate({
					application: declared,
					entryFiles: collectHostImportFiles(server, entry),
				})
				if (closing) throw new HostViteClosedError()
				const next = sourceCandidate.application
				nextCatalog = Object.freeze({
					applicationModule: readLoadedHostApplicationModule(nextFactory),
					modules: sourceCandidate.files,
					plugins: Object.freeze([...next.plugins]),
					definitions: Object.freeze(next.plugins.map(pluginDefinitionAddressOf)),
				})
				for (const [module, definitions] of pipeline.semantics.builtDefinitionModules(
					sourceCandidate.files,
				)) {
					const owner = installedPackageFacts(module)
					if (!owner) continue
					for (const plugin of next.plugins)
						if (definitions.has(pluginDefinitionIndexKey(pluginDefinitionAddressOf(plugin))))
							recordLoadedPluginModule(plugin, module, owner)
				}
				const fixed = new Set(declared.plugins)
				for (const plugin of declared.plugins) {
					if (
						pipeline.semantics.classifyDefinitionArtifact(
							pluginDefinitionAddressOf(plugin),
							sourceCandidate.files,
						) !== 'unreported' ||
						readLoadedPluginModule(plugin)
					)
						continue
					const definition = pluginDefinitionAddressOf(plugin)
					if (definition.entry.kind === 'source-entry') continue
					const specifier =
						definition.entry.packageName +
						(definition.entry.kind === 'package-subpath' ? definition.entry.subpath.slice(1) : '')
					const file = resolveNativeImport(server.config.root, specifier)
					const publicExports = isHostNativeModule(server, file)
						? await import(pathToFileURL(file).href)
						: undefined
					if (publicExports?.[definition.exportName] === plugin) {
						const owner = installedPackageFacts(file)
						if (owner) recordLoadedPluginModule(plugin, file, owner)
					}
				}

				nextProvenance = new Map(
					next.plugins.map((plugin) => {
						const definition = pluginDefinitionAddressOf(plugin)
						let artifactKind = pipeline.semantics.classifyDefinitionArtifact(
							definition,
							sourceCandidate!.files,
						)
						if (artifactKind === 'unreported' && readLoadedPluginModule(plugin))
							artifactKind = 'built-module'
						if (artifactKind === 'unreported')
							throw new TypeError(
								`[host-vite] Plugin ${pluginDefinitionIndexKey(definition)} evaluated by application ${entry} lacks an authoritative source or built artifact fact; load Plugin source through semantic lowering or supply a compiled module with the current literal ABI`,
							)
						const execution: PluginExecutionSnapshot = fixed.has(plugin)
							? {
									kind: 'vite',
									origin: 'fixed',
									artifact: { kind: artifactKind },
									update: { kind: 'host-reload' },
								}
							: {
									kind: 'vite',
									origin: 'source',
									artifact: { kind: artifactKind },
									update: { kind: 'definition-hmr' },
								}
						return [plugin, { execution }]
					}),
				)
				const replace =
					!active || sourceCandidate.declarationsChanged || nextFactory !== applicationFactory
				if (replace) {
					replacement = true
					recentUpdates.updatePhase('application-reload')
					const previous = application
					await devConsole?.hostChanged()
					const previousHost = active
					active = undefined
					compensation = previous
					let nextHost: PluginHost | undefined
					try {
						await previousHost?.close()
						if (closing) throw new HostViteClosedError()
						nextHost = await create(next, nextProvenance, nextCatalog)
						if (closing) throw new HostViteClosedError()
						lifecycle = await nextHost.start()
					} catch (error) {
						const failure = await closeFailedHost(nextHost, error)
						throw failure
					}
					active = nextHost
					accepted = true
				} else {
					try {
						setHostCatalogProvenance(active!.ctx, nextProvenance)
						recentUpdates.updatePhase('artifacts')
						artifactCandidate = await attachments.get(active!)?.prepareCandidate(nextCatalog)
						recentUpdates.updatePhase('commit')
						lifecycle = await updateHostCatalog(active!, next.plugins, {
							onGraphCommitted: () => artifactCandidate?.commit(),
						})
						accepted = true
					} catch (error) {
						// Post-PONR lifecycle/observer failure cannot roll semantic facts back behind the graph.
						accepted = active!.catalog().revision !== previousCatalog?.revision
						throw error
					}
				}
				application = next
				applicationFactory = nextFactory
				fixedApplication = nextFixed
				provenance = nextProvenance
				acceptedCatalog = nextCatalog
				files = sourceCandidate.files
				await settle(true)
				await dependencies?.replace(
					[...files].filter(
						(file) =>
							!sources.covers(file) &&
							(profile === 'production' || file.includes('/node_modules/')),
					),
				)
			})
		} catch (error) {
			let failure = error
			try {
				if (accepted && sourceCandidate) {
					application = sourceCandidate.application
					applicationFactory = nextFactory
					fixedApplication = nextFixed
					provenance = nextProvenance
					acceptedCatalog = nextCatalog
					files = sourceCandidate.files
					await settle(true)
					await dependencies?.replace(
						[...files].filter(
							(file) =>
								!sources.covers(file) &&
								(profile === 'production' || file.includes('/node_modules/')),
						),
					)
				} else {
					if (active) setHostCatalogProvenance(active.ctx, provenance)
					await settle(false)
				}
			} catch (settlementError) {
				failure = new AggregateError(
					[error, settlementError],
					'[host-vite] update settlement failed',
					{ cause: error },
				)
			}
			// Compensation borrows only committed semantic facts, outside the rejected candidate scope.
			if (!accepted && compensation && !closing) {
				let restoredHost: PluginHost | undefined
				try {
					const restoredFixed = await resolveHostApplication(
						applicationFactory!,
						compensation.startup,
					)
					const restoredApplication = { ...restoredFixed, plugins: compensation.plugins }
					restoredHost = await create(restoredApplication, provenance, acceptedCatalog!)
					if (closing) throw new HostViteClosedError()
					lifecycle = await restoredHost.start()
					active = restoredHost
					application = restoredApplication
					fixedApplication = restoredFixed
					restored = true
				} catch (restoreError) {
					const restoreFailure = await closeFailedHost(restoredHost, restoreError)
					failure = new AggregateError(
						[failure, restoreFailure],
						'[host-vite] replacement and compensation failed',
						{ cause: restoreError },
					)
				}
			}
			updateError = describeUpdateError(failure, server.config.root)
			if (!accepted) {
				try {
					const rejected = await candidate.reject()
					updateError = describeUpdateError(failure, server.config.root, rejected?.imports)
				} catch {
					/* Settlement failure is already included above. */
				}
			}
			throw failure
		} finally {
			const commit = lifecycle?.core.status === 'committed' ? lifecycle.core.summary : undefined
			let result: Pick<PluginUpdateBatchSnapshot, 'outcome' | 'phase'>
			if (restored) result = { outcome: 'restored-previous', phase: 'application-reload' }
			else if (accepted) {
				if (updateError) result = { outcome: 'applied-with-issues', phase: 'commit' }
				else if (commit?.lifecycleReport.issues.length)
					result = { outcome: 'applied-with-issues', phase: 'lifecycle' }
				else result = { outcome: 'applied', phase: null }
			} else if (!active) result = { outcome: 'failed', phase: 'application-reload' }
			else {
				const phase = recentUpdates.latestUpdate()?.phase
				result = {
					outcome: 'retained-previous',
					phase: phase === 'evaluate' || phase === 'artifacts' ? phase : 'commit',
				}
			}
			const catalog = active?.catalog()
			// Unknown evaluation failures belong to the attempt, not every old definition.
			const definitionKeys =
				accepted || restored
					? (catalog?.entries ?? [])
							.filter(
								(definition) =>
									replacement ||
									previousCatalog?.byDefinition.get(definition.indexKey)?.candidate
										.implementation !== definition.candidate.implementation,
							)
							.map((definition) => definition.indexKey)
					: []
			recentUpdates.record({
				definitionKeys,
				batch: {
					...result,
					scope: replacement || !active || !sourceCandidate ? 'application' : 'definitions',
					durationMs: performance.now() - started,
				},
				...(commit && active
					? {
							lifecycle: {
								commit,
								addressOf: (slot) => requirePluginService(active!.ctx).nodeAddressOf(slot),
							},
						}
					: {}),
			})
			recentUpdates.finishUpdate(updateError)
		}
	}

	const updateArtifacts = (file: string): Promise<void> =>
		driver.enqueue(async () => {
			if (!active || closing) return
			const candidate = beginHostCandidate({ entry, semantics: pipeline.semantics, recovery })
			let prepared: HostViteCandidate | undefined
			let committed = false
			let updateError: RuntimeUpdateError | null = null
			const started = performance.now()
			recentUpdates.beginUpdate(portableUpdatePath(file, server.config.root))
			recentUpdates.updatePhase('artifacts')
			try {
				await candidate.run(async () => {
					prepared = await attachments.get(active!)?.prepareCandidate(acceptedCatalog!)
				})
				if (closing) throw new HostViteClosedError()
				committed = true
				prepared?.commit()
				recentUpdates.updatePhase('commit')
				await candidate.accept()
			} catch (error) {
				let failure = error
				const results = await Promise.allSettled([
					Promise.resolve().then(() => {
						return !committed ? prepared?.rollback() : undefined
					}),
					committed ? candidate.accept() : candidate.reject(),
				])
				const errors = results.flatMap((result) =>
					result.status === 'rejected' ? [result.reason] : [],
				)
				if (errors.length > 0)
					failure = new AggregateError(
						[error, ...errors],
						'[host-vite] artifact settlement failed',
						{ cause: error },
					)
				updateError = describeUpdateError(failure, server.config.root)
				throw failure
			} finally {
				const result: Omit<PluginUpdateBatchSnapshot, 'sequence'> = {
					scope: 'application',
					outcome: updateError
						? committed
							? 'applied-with-issues'
							: 'retained-previous'
						: 'applied',
					phase: updateError ? (committed ? 'commit' : 'artifacts') : null,
					durationMs: performance.now() - started,
				}
				recentUpdates.record({ definitionKeys: [], batch: result })
				recentUpdates.finishUpdate(updateError)
			}
		})
	const update = (file: string, type: 'create' | 'update' | 'delete'): Promise<void> => {
		if (closing) return Promise.resolve()
		devConsole?.invalidate(file)
		devConsole?.observed(file)
		return driver.enqueue(() => apply({ file: normalizePath(file), type }))
	}
	const sourceFailed = (cause: unknown): void => {
		if (closing) return
		// Watcher failures are application facts, even without a matching catalog definition.
		// Publish in the same lane so an in-flight candidate retains its own settlement.
		void driver
			.enqueue(async () => {
				const diagnostic = describeUpdateError(cause, server.config.root)
				recentUpdates.beginUpdate(diagnostic.file)
				recentUpdates.record({
					definitionKeys: [],
					batch: {
						scope: 'application',
						durationMs: 0,
						...(active
							? ({ outcome: 'retained-previous', phase: 'evaluate' } as const)
							: ({ outcome: 'failed', phase: 'application-reload' } as const)),
					},
				})
				recentUpdates.finishUpdate(diagnostic)
				report(cause)
			})
			.catch(report)
	}
	const close = (): Promise<void> =>
		(shutdown ??= (async () => {
			closing = true
			const drained = driver.close()
			const errors: unknown[] = []
			for (const dispose of [
				() => devConsole?.close(),
				() => sources?.close(),
				() => dependencies?.close(),
				() => recovery.close(),
				() => drained,
				() => active?.close(),
			]) {
				try {
					await dispose()
				} catch (error) {
					errors.push(error)
				}
			}
			if (errors.length > 0)
				throw new AggregateError(errors, '[host-vite] Vite shutdown failed', {
					cause: errors[0],
				})
		})())
	const lifecycle: Plugin = {
		name: 'pluxel:host',
		config(config) {
			profile = hostViteProfile(config.plugins ?? [])
			if (profile === 'production' && enableDevConsole)
				throw new TypeError('[host-vite] devConsole is available only in development')
		},
		apply: 'serve',
		applyToEnvironment(environment) {
			return environment.name === HOST_VITE_ENVIRONMENT
		},
		async configureServer(value) {
			if (profile === 'development') await checkDevelopmentWorkspace(value.config.root)
			server = value
			installHostViteShutdown(server, close)
			dependencies = createHostDependencyWatch({
				onChange: async (file, type) => {
					const changes = await Promise.allSettled(
						Object.values(server.environments).map((environment) =>
							environment.pluginContainer.watchChange(file, { event: type }),
						),
					)
					const errors = changes.flatMap((result) =>
						result.status === 'rejected' ? [result.reason] : [],
					)
					if (errors.length === 1) throw errors[0]
					if (errors.length > 1)
						throw new AggregateError(errors, `[host-vite] Vite watchChange failed for ${file}`, {
							cause: errors[0],
						})
					await update(file, type)
				},
				onError: sourceFailed,
			})
			entry = normalizePath(resolve(server.config.root, inputEntry))
			files.add(entry)
			recovery.attach(server, update, sourceFailed)
			sources = createHostSourceEvaluator({
				server,
				root: server.config.root,
				onError: sourceFailed,
				onEntry: (path) => recovery.includeEntry(path),
				onChange: (change) => {
					void update(
						change.path,
						change.type === 'add' ? 'create' : change.type === 'unlink' ? 'delete' : 'update',
					).catch(report)
				},
			})
			if (profile === 'production') await driver.enqueue(() => apply())
			else await driver.enqueue(() => apply()).catch(report)
			if (enableDevConsole) {
				const { attachDevConsole } = await import('./console/attachment')
				devConsole = await attachDevConsole({
					server,
					getHost: () => active && { ctx: active.ctx, epoch: epochs.get(active)! },
					getApplicationStatus: () => {
						const latestUpdate = recentUpdates.latestUpdate()
						return {
							state: !active
								? 'unavailable'
								: latestUpdate?.state === 'updating'
									? 'updating'
									: 'ready',
							latestUpdate,
						}
					},
					prepare: async (_file, signal) => {
						await driver.settled()
						signal.throwIfAborted()
					},
				})
			}
		},
		hotUpdate: {
			order: 'post',
			async handler(context) {
				if (this.environment.name !== HOST_VITE_ENVIRONMENT || closing) return undefined
				try {
					devConsole?.invalidate(context.file)
					devConsole?.observed(context.file)
					if (sources.covers(context.file)) return undefined
					if (dependencies?.covers(context.file)) return undefined
					if (
						!files.has(context.file) &&
						!recovery.matches(context.file) &&
						!sources.covers(context.file)
					) {
						if (active && attachments.get(active)?.tracks(context.file)) {
							await updateArtifacts(context.file)
							return []
						}
						return undefined
					}
					await update(context.file, context.type)
					return []
				} catch (error) {
					report(error)
					throw error
				}
			},
		},
		closeBundle: close,
	}
	return [
		lifecycle,
		hostSingletons(),
		hostEnvironment(),
		moduleBytes.plugin,
		...pipeline.plugins,
		recovery.plugin,
	]
}

async function closeFailedHost(instance: PluginHost | undefined, error: unknown): Promise<unknown> {
	try {
		await instance?.close()
		return error
	} catch (cleanupError) {
		return new AggregateError([error, cleanupError], '[host-vite] failed Host cleanup', {
			cause: error,
		})
	}
}
