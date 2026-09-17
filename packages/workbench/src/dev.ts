import type { Plugin } from 'vite'
import type { HostDevelopmentPluginApi } from '@pluxel/host-dev/vite'
import { requireWorkbench } from './server'
import { PluginArtifactCompiler } from './development/PluginArtifactCompiler'

export * from './development/PluginArtifactCompiler'

/** Reuses Host's semantic candidate and the same Workbench compiler used by Runtime. */
export function workbenchArtifacts(
	options: Readonly<{ cacheDir?: string }> = {},
): Plugin<HostDevelopmentPluginApi> {
	return {
		name: 'pluxel:workbench-artifacts',
		apply: 'serve',
		api: {
			pluxelHost: {
				async attach({ host, server, semantics }) {
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
					const prepareCandidate = async () => {
						semantics.invalidateWorkbench()
						const [producers, content] = await Promise.all([
							semantics.workbenchCompilations(),
							semantics.workbenchContentCompilations(),
						])
						const nextSources = new Set([
							...producers.flatMap((entry) => [...entry.sources]),
							...content.flatMap((entry) => [...entry.sources]),
						])
						for (const source of nextSources) sources.add(source)
						server.watcher.add([...sources])
						const prepared = await compiler.prepareWorkbenchArtifacts({ producers, content })
						return {
							commit: () => {
								const result = prepared.commit()
								sources = nextSources
								return result
							},
							rollback: () => prepared.rollback(),
						}
					}
					try {
						const initial = await prepareCandidate()
						initial.commit()
					} catch (error) {
						await compiler.dispose()
						throw error
					}
					return {
						prepareCandidate,
						tracks: (file: string) => sources.has(file),
						dispose: () => compiler.dispose(),
					}
				},
			},
		},
	}
}
