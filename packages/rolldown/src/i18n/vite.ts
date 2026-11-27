import { normalize, resolve } from 'pathe'
import type { DevEnvironment, EnvironmentModuleNode, Plugin, ViteDevServer } from 'vite'
import {
	isParaglideGeneratedFile,
	paraglideImportPackageRoot,
	requireParaglideSettingsForImport,
} from './bundler'
import {
	compilePluxelParaglide,
	PLUXEL_PARAGLIDE_SETTINGS,
	readPluxelParaglideProject,
	type PluxelParaglideProject,
} from './paraglide'

type ViteProject = {
	root: string
	settingsPath: string
	environments: Set<string>
	failedImporters: Map<string, Set<string>>
	project?: PluxelParaglideProject
	prepared?: Promise<PluxelParaglideProject | undefined>
}

export type ParaglideViteUpdates = Readonly<{
	tracks(file: string): boolean
	isGenerated(file: string): boolean
	/** Compile eligible projects before the Host invalidates its evaluated modules. */
	prepare(files?: readonly string[]): Promise<readonly string[]>
}>

/** Prepare package-local #i18n imports in a standalone Vite build or dev server. */
export function pluxelParaglideVitePlugin(options: { root?: string } = {}): Plugin {
	return {
		...createParaglideViteIntegration(options).plugin,
		config(config) {
			if (config.server?.watch === null) return undefined
			return { server: { watch: { ignored: ['**/.pluxel/**'] } } }
		},
	}
}

export function createParaglideViteIntegration(
	options: { root?: string } = {},
	host?: { environment: string; watch(files: readonly string[]): Promise<void> },
): { plugin: Plugin; updates: ParaglideViteUpdates } {
	const projects = new Map<string, ViteProject>()
	let server: ViteDevServer | undefined
	let watchTail: Promise<void> = Promise.resolve()
	function register(root: string, environment: string): ViteProject {
		let state = projects.get(root)
		if (!state) {
			state = {
				root,
				settingsPath: resolve(root, PLUXEL_PARAGLIDE_SETTINGS),
				environments: new Set(),
				failedImporters: new Map(),
			}
			projects.set(root, state)
		}
		state.environments.add(environment)
		return state
	}

	function prepare(state: ViteProject): Promise<PluxelParaglideProject | undefined> {
		const pending = (async () => {
			await observe(state)
			// Discover the inputs before compiling so correcting bad messages can retry a cold load.
			const project = server ? await readPluxelParaglideProject(state.root) : undefined
			if (project) {
				state.project = project
				await observe(state)
			}
			const compiled = await compilePluxelParaglide(state.root)
			if (compiled) {
				state.project = compiled
				await observe(state)
			} else if (state.project) throw new Error(`[pluxel:i18n] Missing ${state.settingsPath}`)
			return compiled
		})()
		state.prepared = pending
		void pending.catch(() => {
			if (state.prepared === pending) state.prepared = undefined
		})
		return pending
	}

	async function observe(state: ViteProject): Promise<void> {
		if (!server) return
		const project = state.project
		server.watcher.add(
			project ? [...project.watchRoots, ...project.watchFiles] : state.settingsPath,
		)
		if (!host || !state.environments.has(host.environment)) return
		// Serialize watcher replacements while independent package resolutions run in parallel.
		const pending = watchTail.then(() =>
			host.watch(
				matchingProjects(host.environment).flatMap(
					(item) => item.project?.watchFiles ?? [item.settingsPath],
				),
			),
		)
		watchTail = pending.catch(() => {})
		await pending
	}

	function matchingProjects(environment: string, files?: readonly string[]): ViteProject[] {
		return [...projects.values()].filter(
			(state) =>
				state.environments.has(environment) &&
				(!files ||
					files.some((file) => file === state.settingsPath || state.project?.matchesSource(file))),
		)
	}

	async function refresh(states: readonly ViteProject[]): Promise<ReadonlySet<string>> {
		const compiled = await Promise.all(states.map(prepare))
		return new Set(compiled.flatMap((project) => (project ? [project.outdir] : [])))
	}

	const plugin: Plugin = {
		name: 'pluxel:paraglide',
		enforce: 'pre',
		configureServer(value) {
			server = value
		},
		async buildStart() {
			if (this.environment.mode !== 'build') return
			const state = register(
				resolve(options.root ?? this.environment.config.root),
				this.environment.name,
			)
			const project = await (state.prepared ?? prepare(state))
			if (project) for (const file of project.watchFiles) this.addWatchFile(file)
		},
		watchChange(file) {
			if (this.environment.mode === 'build') {
				for (const state of matchingProjects(this.environment.name, [file])) {
					state.prepared = undefined
				}
			}
		},
		async resolveId(source, importer) {
			const root = paraglideImportPackageRoot(source, importer)
			if (root === undefined) return null
			const environment = this.environment.name
			const firstHostUse =
				environment === host?.environment && !projects.get(root)?.environments.has(environment)
			const state = register(root, environment)
			try {
				if (firstHostUse && state.prepared) await observe(state)
				const project = await (state.prepared ?? prepare(state))
				if (!project) await requireParaglideSettingsForImport(root)
				else if (this.environment.mode === 'build')
					for (const file of project.watchFiles) this.addWatchFile(file)
			} catch (error) {
				const failed = state.failedImporters.get(environment) ?? new Set<string>()
				failed.add(normalize(importer!.split(/[?#]/, 1)[0]!))
				state.failedImporters.set(environment, failed)
				throw error
			}
			return null
		},
		async hotUpdate({ file, modules, read, timestamp, type }) {
			const states = matchingProjects(this.environment.name, [file]).filter(
				(state) => !host || !state.environments.has(host.environment),
			)
			if (states.length === 0) return undefined
			if (type === 'update') await read()
			const roots = await refresh(states)
			const graph = this.environment.moduleGraph
			const files = affectedFiles(this.environment, roots, states)
			const updates = new Set(modules)
			const invalidated = new Set<EnvironmentModuleNode>()
			for (const path of files) {
				for (const module of graph.getModulesByFile(path) ?? []) {
					graph.invalidateModule(module, invalidated, timestamp, true)
					updates.add(module)
				}
			}
			return [...updates]
		},
	}
	return {
		plugin,
		updates: {
			tracks: (file) =>
				host !== undefined && matchingProjects(host.environment, [normalize(file)]).length > 0,
			isGenerated: isParaglideGeneratedFile,
			async prepare(files) {
				if (!server || !host) return []
				const states = matchingProjects(host.environment, files)
				if (states.length === 0) return []
				const roots = await refresh(states)
				return affectedFiles(server.environments[host.environment], roots, states)
			},
		},
	}
}

function affectedFiles(
	environment: DevEnvironment,
	roots: ReadonlySet<string>,
	states: readonly ViteProject[],
): string[] {
	const prefixes = [...roots].map((root) => `${root}/`)
	const files = new Set(
		[...environment.moduleGraph.fileToModulesMap.keys()].filter((file) =>
			prefixes.some((prefix) => file.startsWith(prefix)),
		),
	)
	for (const state of states) {
		for (const file of state.failedImporters.get(environment.name) ?? []) files.add(file)
		state.failedImporters.delete(environment.name)
	}
	return [...files]
}
