import { resolve } from 'node:path'
import { createHost, type HostApplication, type PluginHost } from '@pluxel/host'
import { installPluginSources } from '@pluxel/host/internal'
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

export type HostViteOptions = Readonly<{
	/** Application module default-exporting a HostApplication. Relative to Vite root. */
	entry: string
}>

/** Core-only Vite assembly, sharing the Runtime's runner, source evaluator and candidate protocol. */
export function host(options: HostViteOptions): PluginOption[] {
	if (!options.entry?.trim()) throw new TypeError('[host-dev/vite] entry is required')
	const pipeline = createPluginSourceVitePipeline({ preset: 'core' })
	const recovery = new ViteApplicationRecovery()
	const driver = createHostDevelopmentDriver()
	let server: ViteDevServer
	let entry: string
	let sources: ReturnType<typeof createHostSourceEvaluator>
	let active: PluginHost | undefined
	let application: HostApplication | undefined
	let files = new Set<string>()
	let closing = false
	const report = (error: unknown): void => {
		if (active) active.ctx.logger.error('Host candidate rejected', { error })
		else
			server.config.logger.error('Host candidate rejected', {
				error: error as Error,
			})
	}
	const create = (declaration: HostApplication): PluginHost => {
		const instance = createHost({
			plugins: declaration.plugins,
			config: declaration.config,
			state: declaration.state,
		})
		installPluginSources(instance.ctx, {
			root: server.config.root,
			sources: declaration.sources ?? [],
		})
		return instance
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
		const settle = async (accept: boolean): Promise<void> => {
			const results = await Promise.allSettled([
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
					changed?.file === entry ||
					(!catalogChanged &&
						changed &&
						!sourceCandidate.sourceModules.has(changed.file) &&
						!sourceCandidate.sourceFiles.has(changed.file))
				if (replace) {
					const previous = application
					await active?.close()
					active = undefined
					if (closing) throw new HostDevelopmentClosedError()
					const nextHost = create(next)
					try {
						await nextHost.start()
					} catch (error) {
						await nextHost.close()
						if (previous && !closing) {
							const restored = create(previous)
							try {
								await restored.start()
								active = restored
							} catch (restoreError) {
								await restored.close()
								throw new AggregateError(
									[error, restoreError],
									'[host-dev] replacement and compensation failed',
									{ cause: restoreError },
								)
							}
						}
						throw error
					}
					active = nextHost
					accepted = true
				} else {
					try {
						await active!.updateCatalog(next.plugins)
						accepted = true
					} catch (error) {
						// Post-PONR lifecycle/observer failure cannot roll semantic facts back behind the graph.
						const catalog = active!.catalog()
						accepted =
							catalog.entries.length === next.plugins.length &&
							catalog.entries.every((definition) =>
								next.plugins.includes(definition.candidate.implementation),
							)
						throw error
					}
				}
				application = next
				files = sourceCandidate.files
				await settle(true)
			})
		} catch (error) {
			if (accepted && sourceCandidate) {
				application = sourceCandidate.application
				files = sourceCandidate.files
				await settle(true)
			} else {
				await settle(false)
			}
			throw error
		}
	}
	const update = (file: string, type: 'create' | 'update' | 'delete'): Promise<void> => {
		if (closing) return Promise.resolve()
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
		},
		hotUpdate: {
			order: 'post',
			async handler(context) {
				if (this.environment.name !== 'ssr' || closing || sources.covers(context.file))
					return undefined
				if (
					!files.has(context.file) &&
					!recovery.matches(context.file) &&
					!sources.covers(context.file)
				)
					return undefined
				await update(context.file, context.type)
				return []
			},
		},
		async closeBundle() {
			closing = true
			const drained = driver.close()
			const errors: unknown[] = []
			for (const close of [
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
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('[host-dev] entry must default-export a HostApplication object')
	const declaration = value as Record<string, unknown>
	if (!Array.isArray(declaration.plugins))
		throw new TypeError('[host-dev] application.plugins must be an array')
	if (declaration.sources !== undefined && !Array.isArray(declaration.sources))
		throw new TypeError('[host-dev] application.sources must be an array')
	return declaration as HostApplication
}
