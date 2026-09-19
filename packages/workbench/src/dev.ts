import { pluginDefinitionIndexKey } from '@pluxel/core'
import { installPluxelViteUrlPrinter } from '@pluxel/host-dev/internal/vite-urls'
import { hostEnv } from '@pluxel/host/environment'
import { workbenchShellMount } from './shell/mount'
import type { Plugin } from 'vite'
import type { HostDevelopmentPluginApi, HostDevelopmentCatalog } from '@pluxel/host-dev/vite'
import { requireWorkbench } from './server'
import { readDevelopmentPackagedArtifacts } from './development/packaged-artifacts'
import {
	PluginArtifactCompiler,
	type WorkbenchArtifactCompilations,
} from './development/PluginArtifactCompiler'

// A compensation Host reuses the accepted plan, never a newly overwritten package inventory.
// Artifact bytes still pass coordinator validation; a deleted old revision cannot be restored.
type AcceptedWorkbenchInputs = Readonly<{
	compilations: WorkbenchArtifactCompilations
	sources: ReadonlySet<string>
}>
const acceptedInputs = new WeakMap<HostDevelopmentCatalog, AcceptedWorkbenchInputs>()

export * from './development/PluginArtifactCompiler'

/** Admits source compilations and installed package inventories with Host's semantic candidate. */
export function workbenchArtifacts(
	options: Readonly<{ cacheDir?: string }> = {},
): Plugin<HostDevelopmentPluginApi> {
	return {
		name: 'pluxel:workbench-artifacts',
		apply: 'serve',
		api: {
			pluxelHost: {
				async attach({ host, server, semantics, catalog: initialCatalog }) {
					const removeUrlPrinter = installPluxelViteUrlPrinter(server, {
						publicOrigin: hostEnv.portlessOrigin,
						workbenchBasePath: () => workbenchShellMount(host.ctx),
					})
					const backend = requireWorkbench(host.ctx)
					const compiler = new PluginArtifactCompiler(
						host.ctx,
						{
							coordinator: backend.artifactCoordinator,
							producerStatus: backend.producerStatus,
							viteServer: server,
						},
						{ cacheDir: options.cacheDir, packageMode: 'development' },
					)
					let sources = new Set<string>()
					const readInputs = async (catalog: HostDevelopmentCatalog) => {
						semantics.invalidateWorkbench()
						const selected = new Set(catalog.definitions.map(pluginDefinitionIndexKey))
						const [allProducers, allContent, packaged] = await Promise.all([
							semantics.workbenchCompilations(),
							semantics.workbenchContentCompilations(),
							readDevelopmentPackagedArtifacts(
								semantics.builtDefinitionModules(catalog.modules),
								selected,
							),
						])
						const producers = allProducers.filter((entry) =>
							selected.has(pluginDefinitionIndexKey(entry.plan.definition)),
						)
						const content = allContent.filter((entry) =>
							selected.has(pluginDefinitionIndexKey(entry.contentSet.definition)),
						)
						return {
							compilations: { producers, content, packaged },
							sources: new Set([
								...producers.flatMap((entry) => entry.sources),
								...content.flatMap((entry) => entry.sources),
							]),
						}
					}
					const prepareInputs = async (
						catalog: HostDevelopmentCatalog,
						input: AcceptedWorkbenchInputs,
					) => {
						for (const source of input.sources) sources.add(source)
						server.watcher.add([...sources])
						const prepared = await compiler.prepareWorkbenchArtifacts(input.compilations)
						let settled = false
						return {
							commit: () => {
								if (settled) return
								settled = true
								prepared.commit()
								acceptedInputs.set(catalog, input)
								sources = new Set(input.sources)
							},
							rollback: () => {
								if (settled) return
								settled = true
								prepared.rollback()
							},
						}
					}
					const prepareCandidate = async (catalog: HostDevelopmentCatalog) =>
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
						tracks: (file: string) => sources.has(file),
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
