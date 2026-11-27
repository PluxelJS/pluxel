import { pluginDefinitionIndexKey } from '@pluxel/core'
import { installPluxelViteUrlPrinter } from '@pluxel/host-vite/internal'
import { resolveHostEnv } from '@pluxel/host/environment'
import { workbenchShellMount } from './shell/mount'
import type { Plugin } from 'vite'
import type { HostVitePluginApi, HostViteCatalog, HostViteCandidate } from '@pluxel/host-vite'
import { WorkbenchHost } from './server'
import { readLoadedWorkbenchArtifacts } from './services/workbench/loaded-artifacts'
import {
	PluginArtifactCompiler,
	type WorkbenchArtifactCompilations,
} from './development/PluginArtifactCompiler'

// A compensation Host reuses the accepted plan, never a newly overwritten package inventory.
// Artifact bytes still pass coordinator validation; a deleted old revision cannot be restored.
type AcceptedWorkbenchInputs = Readonly<{
	compilations: WorkbenchArtifactCompilations
	sources: ReadonlySet<string>
	i18n: ReadonlyMap<string, WorkbenchTranslationWatch>
}>
type WorkbenchTranslationWatch = Readonly<{
	watchRoots: readonly string[]
	matchesSource(file: string): boolean
}>
const acceptedInputs = new WeakMap<HostViteCatalog, AcceptedWorkbenchInputs>()

export * from './development/PluginArtifactCompiler'

/** Admits source compilations and installed package inventories with Host's semantic candidate. */
export function workbenchArtifacts(
	options: Readonly<{ cacheDir?: string }> = {},
): Plugin<HostVitePluginApi> {
	return {
		name: 'pluxel:workbench-artifacts',
		apply: 'serve',
		api: {
			pluxelHost: {
				async attach({ host, server, semantics, catalog: initialCatalog, profile, startup }) {
					const environment = resolveHostEnv(startup.env)
					const removeUrlPrinter = installPluxelViteUrlPrinter(server, {
						publicOrigin: environment.publicOrigin,
						workbenchBasePath: () => workbenchShellMount(host.ctx),
					})
					const backend = host.ctx.service(WorkbenchHost)
					const compiler = new PluginArtifactCompiler(
						host.ctx,
						{
							coordinator: backend.artifactCoordinator,
							producerStatus: backend.producerStatus,
							viteServer: server,
						},
						{
							cacheDir: options.cacheDir,
							packageMode: profile === 'production' ? 'distribution' : 'development',
						},
					)
					let sources = new Set<string>()
					let watchedProjects = new Map<string, WorkbenchTranslationWatch>()
					const watchSources = () => {
						server.watcher.add([
							...sources,
							...new Set([...watchedProjects.values()].flatMap((project) => project.watchRoots)),
						])
					}
					const readInputs = async (catalog: HostViteCatalog) => {
						semantics.invalidateWorkbench()
						const selected = new Set(catalog.definitions.map(pluginDefinitionIndexKey))
						const [producers, content, packaged] = await Promise.all([
							semantics.workbenchCompilations(selected),
							semantics.workbenchContentCompilations(selected),
							readLoadedWorkbenchArtifacts(
								semantics.builtDefinitionModules(catalog.modules),
								selected,
							),
						]).catch(async (error) => {
							if (watchedProjects.size > 0) {
								// A valid pathPattern can point to messages that fail compilation. Watch those paths
								// so fixing a translation can recover the next candidate.
								const { readPluxelParaglideProject } =
									await import('@pluxel/rolldown/vite/paraglide')
								const projects = await Promise.allSettled(
									[...watchedProjects.keys()].map((root) => readPluxelParaglideProject(root)),
								)
								for (const result of projects) {
									if (result.status === 'fulfilled' && result.value) {
										watchedProjects.set(result.value.packageRoot, result.value)
									}
								}
								watchSources()
							}
							throw error
						})
						return {
							compilations: { producers, content, packaged },
							sources: new Set([
								...producers.flatMap((entry) => entry.sources),
								...content.flatMap((entry) => entry.sources),
							]),
							i18n: new Map(
								producers.flatMap(({ i18n }) =>
									(i18n ?? []).map((project) => [project.packageRoot, project] as const),
								),
							),
						}
					}
					const prepareInputs = async (
						catalog: HostViteCatalog,
						input: AcceptedWorkbenchInputs,
					): Promise<HostViteCandidate> => {
						for (const source of input.sources) sources.add(source)
						for (const [root, project] of input.i18n) watchedProjects.set(root, project)
						watchSources()
						const prepared = await compiler.prepareWorkbenchArtifacts(input.compilations)
						let settled = false
						return {
							commit: () => {
								if (settled) return
								settled = true
								prepared.commit()
								acceptedInputs.set(catalog, input)
								sources = new Set(input.sources)
								watchedProjects = new Map(input.i18n)
							},
							rollback: () => {
								if (settled) return
								settled = true
								prepared.rollback()
							},
						}
					}
					const prepareCandidate = async (catalog: HostViteCatalog) =>
						prepareInputs(catalog, await readInputs(catalog))
					try {
						const initial = await prepareInputs(
							initialCatalog,
							acceptedInputs.get(initialCatalog) ?? (await readInputs(initialCatalog)),
						)
						initial.commit()
					} catch (error) {
						removeUrlPrinter()
						await compiler.dispose()
						throw error
					}
					return {
						prepareCandidate,
						tracks: (file: string) =>
							sources.has(file) ||
							[...watchedProjects.values()].some((project) => project.matchesSource(file)),
						dispose: async () => {
							removeUrlPrinter()
							await compiler.dispose()
						},
					}
				},
			},
		},
	}
}
