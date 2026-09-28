import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Native ESM loader whose source graphs borrow the deployment's exact framework instances. */
export function createProductionSourceLoader(
	frameworkModules?: Readonly<Record<string, string>>,
	workbenchCapnwebVersion?: string,
) {
	const entries = new Set<string>()
	const ownedModules = new Set<string>()
	const loadedEntries = new Set<string>()
	const frameworks = new Map(Object.entries(frameworkModules ?? {}))
	const frameworkPackages = new Set([...frameworks.keys()].map(packageName))
	const packageFacts = new Map<string, SourcePackageFacts>()
	let closed = false
	const hooks =
		frameworks.size > 0
			? registerHooks({
					resolve(specifier, context, nextResolve) {
						const sourceOwned =
							entries.has(specifier) ||
							(context.parentURL !== undefined && ownedModules.has(context.parentURL))
						if (!sourceOwned) return nextResolve(specifier, context)
						if (workbenchCapnwebVersion && packageName(specifier) === 'capnweb') {
							const facts = context.parentURL?.startsWith('file:')
								? sourcePackageFacts(context.parentURL, packageFacts)
								: undefined
							let resolved: ReturnType<typeof nextResolve>
							try {
								resolved = nextResolve(specifier, context)
							} catch (cause) {
								if (
									!facts ||
									(facts.workbenchCapnweb === undefined && facts.capnwebPeer === undefined) ||
									specifier !== 'capnweb'
								)
									throw cause
								throw workbenchVersionError(
									facts,
									'<missing>',
									'<missing>',
									workbenchCapnwebVersion,
								)
							}
							if (
								facts &&
								(facts.workbenchCapnweb !== undefined || facts.capnwebPeer !== undefined) &&
								specifier === 'capnweb'
							) {
								const actual = resolved.url.startsWith('file:')
									? (sourcePackageFacts(resolved.url, packageFacts)?.version ?? '<unknown>')
									: '<unresolved>'
								if (
									facts.capnwebPeer !== workbenchCapnwebVersion ||
									(facts.workbenchCapnweb !== undefined &&
										facts.workbenchCapnweb !== workbenchCapnwebVersion) ||
									actual !== workbenchCapnwebVersion
								) {
									throw workbenchVersionError(facts, actual, resolved.url, workbenchCapnwebVersion)
								}
								const shared = frameworks.get('capnweb')
								if (!shared) throw new Error('Production Workbench capnweb facade is unavailable')
								return { url: shared, shortCircuit: true }
							}
							if (resolved.url.startsWith('file:')) ownedModules.add(resolved.url)
							return resolved
						}
						const framework = frameworks.get(specifier)
						if (framework) return { url: framework, shortCircuit: true }
						if (frameworkPackages.has(packageName(specifier))) {
							throw Object.assign(
								new Error(
									`Plugin source imports an unavailable deployment framework entry: ${specifier}`,
								),
								{
									code: 'PLUGIN_SOURCE_FRAMEWORK_ENTRY_UNAVAILABLE',
								},
							)
						}
						const result = nextResolve(specifier, context)
						if (result.url.startsWith('file:')) ownedModules.add(result.url)
						return result
					},
				})
			: undefined
	return {
		async load(path: string): Promise<unknown> {
			if (closed) throw new Error('Production Plugin source loader is closed')
			const url = pathToFileURL(path).href
			if (loadedEntries.has(url)) {
				throw Object.assign(
					new Error(
						`Production Plugin source replacement requires a process restart: ${path}. Node ESM caches transitive imports; changing an entry URL cannot refresh its dependency graph.`,
					),
					{ code: 'PLUGIN_SOURCE_RESTART_REQUIRED' },
				)
			}
			loadedEntries.add(url)
			entries.add(url)
			return import(url)
		},
		/** Called after source admission, evaluation and every Plugin generation have drained. */
		close(): void {
			if (closed) return
			closed = true
			hooks?.deregister()
			entries.clear()
			ownedModules.clear()
		},
	}
}

type SourcePackageFacts = Readonly<{
	owner: string
	manifestPath: string
	capnwebPeer?: string
	workbenchCapnweb?: string
	version?: string
}>

function workbenchVersionError(
	facts: SourcePackageFacts,
	actual: string,
	actualEntry: string,
	supported: string,
): Error {
	return Object.assign(
		new Error(
			`Workbench capnweb admission failed for ${facts.owner} (${facts.manifestPath}): ` +
				`peerDependencies.capnweb ${facts.capnwebPeer ?? '<missing>'}, ` +
				`pluxel.workbenchCapnweb ${facts.workbenchCapnweb ?? '<absent>'}; ` +
				`resolved ${actual} at ${actualEntry}; Host Workbench supports ${supported}. ` +
				`Update the publisher peer and installation, then restart the Host.`,
		),
		{ code: 'PLUGIN_SOURCE_WORKBENCH_CAPNWEB_MISMATCH' },
	)
}

function sourcePackageFacts(
	url: string,
	cache: Map<string, SourcePackageFacts>,
): SourcePackageFacts | undefined {
	let directory = dirname(fileURLToPath(url))
	for (;;) {
		const cached = cache.get(directory)
		if (cached) return cached
		const path = join(directory, 'package.json')
		if (existsSync(path)) {
			const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
				name?: string
				version?: string
				peerDependencies?: { capnweb?: unknown }
				pluxel?: { workbenchCapnweb?: unknown }
			}
			const facts = Object.freeze({
				owner: manifest.name ?? path,
				manifestPath: path,
				...(typeof manifest.peerDependencies?.capnweb === 'string'
					? { capnwebPeer: manifest.peerDependencies.capnweb }
					: {}),
				...(manifest.version ? { version: manifest.version } : {}),
				...(typeof manifest.pluxel?.workbenchCapnweb === 'string'
					? { workbenchCapnweb: manifest.pluxel.workbenchCapnweb }
					: {}),
			})
			cache.set(directory, facts)
			return facts
		}
		const parent = dirname(directory)
		if (parent === directory) return undefined
		directory = parent
	}
}

function packageName(specifier: string): string {
	const parts = specifier.split('/')
	return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}
