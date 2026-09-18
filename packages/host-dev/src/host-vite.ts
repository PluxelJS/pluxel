import { requirePluginService } from '@pluxel/core/internal'
import { randomUUID } from 'node:crypto'
import type { DevConsoleAttachment } from './console/attachment'
import { resolve } from 'node:path'
import {
	createHost,
	resolveHostApplication,
	prepareHostApplication,
	assertHostApplication,
	type HostApplication,
	type PluginHost,
	type PluginApplyReport,
} from '@pluxel/host'
import {
	installPluginSources,
	installHostRecentUpdates,
	PluginRecentUpdateTracker,
	type PluginUpdateBatchSnapshot,
	type RuntimeUpdateError,
} from '@pluxel/host/internal'
import { portableUpdatePath, describeUpdateError } from './internal/update-error'
import { createPluginSourceVitePipeline } from '@pluxel/rolldown/vite'
import { normalizePath, type Plugin, type PluginOption, type ViteDevServer } from 'vite'
import { createHostDevelopmentDriver, HostDevelopmentClosedError } from './driver'
import { beginHostCandidate } from './candidate'
import { createHostSourceEvaluator, type HostSourceCandidate } from './application-sources'
import { ViteApplicationRecovery } from './internal/vite-application-recovery'
import { invalidateHostChangedModules } from './invalidation'
import { collectViteSsrImportFiles, importViteSsrModule, invalidateViteSsrModule } from './runner'
import { createHostModuleVitePlugin } from './host-modules'
import { hostSingletons } from './singletons'
import { attachHostDevelopmentPlugins, type HostDevelopmentCandidate } from './attachments'

export type HostViteOptions = Readonly<{
	/** Application module default-exporting a HostApplication. Relative to Vite root. */
	entry: string
	/** Enable the local TypeScript console. @default false */
	devConsole?: boolean
}>

/** Composable Host Vite assembly, sharing the Runtime's runner, source evaluator and candidate protocol. */
export function host(options: HostViteOptions): PluginOption[] {
	if (!options.entry?.trim()) throw new TypeError('[host-dev/vite] entry is required')
	if (options.devConsole !== undefined && typeof options.devConsole !== 'boolean')
		throw new TypeError('[host-dev] devConsole must be a boolean')
	const pipeline = createPluginSourceVitePipeline({ preset: 'core' })
	const recovery = new ViteApplicationRecovery()
	const driver = createHostDevelopmentDriver()
	const recentUpdates = new PluginRecentUpdateTracker()
	let server: ViteDevServer
	let entry: string
	let sources: ReturnType<typeof createHostSourceEvaluator>
	let active: PluginHost | undefined
	let application: HostApplication | undefined
	let files = new Set<string>()
	let closing = false
	let devConsole: DevConsoleAttachment | undefined
	const epochs = new WeakMap<PluginHost, string>()
	const attachments = new WeakMap<
		PluginHost,
		Awaited<ReturnType<typeof attachHostDevelopmentPlugins>>
	>()
	const report = (error: unknown): void => {
		if (active) active.ctx.logger.error('Host candidate rejected', { error })
		else
			server.config.logger.error('Host candidate rejected', {
				error: error as Error,
			})
	}
	const create = async (input: HostApplication): Promise<PluginHost> => {
		const startup = {
			root: server.config.root,
			mode: 'development' as const,
			env: process.env,
			bindings: {},
		}
		const declaration = await resolveHostApplication(input, startup)
		const instance = await createHost({
			plugins: declaration.plugins,
			config: declaration.config,
			state: declaration.state,
			configRecords: declaration.configRecords,
			services: declaration.services,
		})
		try {
			installHostRecentUpdates(instance.ctx, recentUpdates)
			installPluginSources(instance.ctx, {
				root: server.config.root,
				sources: declaration.sources ?? [],
			})
			attachments.set(
				instance,
				await attachHostDevelopmentPlugins(instance, server, pipeline.semantics),
			)
			await prepareHostApplication(declaration, instance, startup)
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
		if (changed) {
			const invalidation = invalidateHostChangedModules({
				server,
				changedFile: changed.file,
				applicationFiles: recovery.invalidationFiles(files),
				changedModules: [],
				recoverMissingImports:
					recovery.matches(changed.file) ||
					(changed.type === 'create' && !sources.covers(changed.file)),
				reloadDependencies: sources.covers(changed.file),
			})
			for (const file of invalidation.modules) invalidateViteSsrModule(server, file)
		}
		const candidate = beginHostCandidate({ entry, semantics: pipeline.semantics, recovery })
		let sourceCandidate: HostSourceCandidate<HostApplication> | undefined
		let accepted = false
		let restored = false
		let replacement = false
		let lifecycle: PluginApplyReport | undefined
		let updateError: RuntimeUpdateError | null = null
		const started = performance.now()
		const previousCatalog = active?.catalog()
		recentUpdates.beginUpdate(changed ? portableUpdatePath(changed.file, server.config.root) : null)
		let artifactCandidate: HostDevelopmentCandidate | undefined
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
				throw new AggregateError(errors, '[host-dev] candidate settlement failed')
		}
		try {
			await candidate.run(async () => {
				const namespace = await importViteSsrModule<Record<string, unknown>>(server, entry)
				const declared = readApplication(namespace.default)
				sourceCandidate = await sources.evaluate({
					application: declared,
					entryFiles: collectViteSsrImportFiles(server, entry),
				})
				if (closing) throw new HostDevelopmentClosedError()
				const next = sourceCandidate.application
				const catalogChanged =
					!application ||
					application.plugins.length !== next.plugins.length ||
					application.plugins.some((plugin, index) => plugin !== next.plugins[index])
				const replace =
					!active ||
					sourceCandidate.declarationsChanged ||
					!sameServices(application?.services, next.services) ||
					changed?.file === entry ||
					(!catalogChanged &&
						changed &&
						!sourceCandidate.sourceModules.has(changed.file) &&
						!sourceCandidate.sourceFiles.has(changed.file))
				if (replace) {
					replacement = true
					recentUpdates.updatePhase('application-reload')
					const previous = application
					await devConsole?.hostChanged()
					const previousHost = active
					active = undefined
					let nextHost: PluginHost | undefined
					try {
						await previousHost?.close()
						if (closing) throw new HostDevelopmentClosedError()
						nextHost = await create(next)
						if (closing) throw new HostDevelopmentClosedError()
						lifecycle = await nextHost.start()
					} catch (error) {
						const failure = await closeFailedHost(nextHost, error)
						if (previous && !closing) {
							let restoredHost: PluginHost | undefined
							try {
								restoredHost = await create(previous)
								if (closing) throw new HostDevelopmentClosedError()
								lifecycle = await restoredHost.start()
								active = restoredHost
								restored = true
							} catch (restoreError) {
								const restoreFailure = await closeFailedHost(restoredHost, restoreError)
								throw new AggregateError(
									[failure, restoreFailure],
									'[host-dev] replacement and compensation failed',
									{ cause: restoreError },
								)
							}
						}
						throw failure
					}
					active = nextHost
					accepted = true
				} else {
					try {
						recentUpdates.updatePhase('artifacts')
						artifactCandidate = await attachments.get(active!)?.prepareCandidate()
						recentUpdates.updatePhase('commit')
						lifecycle = await active!.updateCatalog(next.plugins)
						accepted = true
					} catch (error) {
						// Post-PONR lifecycle/observer failure cannot roll semantic facts back behind the graph.
						accepted = active!.catalog().revision !== previousCatalog?.revision
						throw error
					}
				}
				application = next
				files = sourceCandidate.files
				await settle(true)
			})
		} catch (error) {
			let failure = error
			try {
				if (accepted && sourceCandidate) {
					application = sourceCandidate.application
					files = sourceCandidate.files
					await settle(true)
				} else {
					await settle(false)
				}
			} catch (settlementError) {
				failure = new AggregateError(
					[error, settlementError],
					'[host-dev] update settlement failed',
					{ cause: error },
				)
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
			let prepared: HostDevelopmentCandidate | undefined
			let committed = false
			let updateError: RuntimeUpdateError | null = null
			const started = performance.now()
			recentUpdates.beginUpdate(portableUpdatePath(file, server.config.root))
			recentUpdates.updatePhase('artifacts')
			try {
				await candidate.run(async () => {
					prepared = await attachments.get(active!)?.prepareCandidate()
				})
				if (closing) throw new HostDevelopmentClosedError()
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
						'[host-dev] artifact settlement failed',
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
	const lifecycle: Plugin = {
		name: 'pluxel:host',
		apply: 'serve',
		async configureServer(value) {
			server = value
			entry = normalizePath(resolve(server.config.root, options.entry))
			files.add(entry)
			recovery.attach(server, update)
			sources = createHostSourceEvaluator({
				server,
				root: server.config.root,
				onError: report,
				onChange: (change) => {
					void update(
						change.path,
						change.type === 'add' ? 'create' : change.type === 'unlink' ? 'delete' : 'update',
					).catch(report)
				},
			})
			await driver.enqueue(() => apply()).catch(report)
			if (options.devConsole) {
				const { attachDevConsole } = await import('./console/attachment')
				devConsole = await attachDevConsole({
					server,
					getHost: () => active && { ctx: active.ctx, epoch: epochs.get(active)! },
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
				if (this.environment.name !== 'ssr' || closing) return undefined
				devConsole?.invalidate(context.file)
				devConsole?.observed(context.file)
				if (sources.covers(context.file)) return undefined
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
			},
		},
		async closeBundle() {
			closing = true
			const drained = driver.close()
			const errors: unknown[] = []
			for (const close of [
				() => devConsole?.close(),
				() => sources?.close(),
				() => recovery.close(),
				() => drained,
				() => active?.close(),
			]) {
				try {
					await close()
				} catch (error) {
					errors.push(error)
				}
			}
			if (errors.length > 0)
				throw new AggregateError(errors, '[host-dev] development shutdown failed')
		},
	}
	return [
		hostSingletons(),
		createHostModuleVitePlugin(),
		...pipeline.plugins,
		recovery.plugin,
		lifecycle,
	]
}

function readApplication(value: unknown): HostApplication {
	assertHostApplication(value)
	return value
}

function sameServices(
	left: HostApplication['services'],
	right: HostApplication['services'],
): boolean {
	const previous = left ?? []
	const next = right ?? []
	return (
		previous.length === next.length && previous.every((service, index) => service === next[index])
	)
}

async function closeFailedHost(instance: PluginHost | undefined, error: unknown): Promise<unknown> {
	try {
		await instance?.close()
		return error
	} catch (cleanupError) {
		return new AggregateError([error, cleanupError], '[host-dev] failed Host cleanup', {
			cause: error,
		})
	}
}
