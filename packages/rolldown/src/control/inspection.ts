import { resolve } from 'node:path'
import {
	formatPluginDefinitionReference,
	parsePluginDefinitionAddress,
	parsePluginDefinitionReference,
	type PluginDefinitionAddress,
	type ServiceDefinitionAddress,
} from '@pluxel/core'
import { readControlCatalog } from './inspect-catalog'
import type { ControlConfigInspection } from './inspect-config'
import type {
	ControlCatalogPluginEntry,
	ControlCatalogServiceEntry,
	PluginControlManifest,
} from './manifest'
import type { ControlInterface, createControlInspector } from './inspect-interface'

export type {
	ControlConfigInspection,
	ControlConfigSource,
	ControlConfigDependency,
} from './inspect-config'
export type {
	ControlInterfaceMember,
	ControlTypeDeclaration,
	ControlTypeLocation,
} from './inspect-interface'

export type ControlPluginSummary = ControlCatalogPluginEntry
export type ControlServiceSummary = ControlCatalogServiceEntry

export interface ControlPluginInspection
	extends Pick<ControlPluginSummary, 'reference' | 'exportName' | 'hasConfig'>, ControlInterface {
	/** Copy into a Host script. Imports its generated descriptor without loading the implementation. */
	readonly importStatement: string
}

export interface ControlServiceInspection
	extends Pick<ControlServiceSummary, 'reference' | 'exportName' | 'access'>, ControlInterface {
	/** Import this generated Service definition for use with sdk.ctx.service(). */
	readonly importStatement: string
}

export interface ControlCatalog extends Disposable {
	/** Physical material directory. Relative declaration locations resolve here even after resync. */
	readonly root: string
	/** Material snapshot recorded in the opened manifest. */
	readonly snapshot: string
	/** Only plugins present in this material. Listing never starts a compiler. */
	readonly plugins: readonly ControlPluginSummary[]
	/** Services provided by this material, including their declared access scope. */
	readonly services: readonly ControlServiceSummary[]
	/** Read generated config I/O and schema sources. A plugin without managed config returns null. */
	inspectConfig(target: string | PluginDefinitionAddress): Promise<ControlConfigInspection | null>
	/** Read public instance members, or inspect one member and its referenced contract types. */
	inspectPlugin(
		target: string | PluginDefinitionAddress,
		options?: { readonly member?: string },
	): Promise<ControlPluginInspection>
	/** Read the Service contract or one operation and its referenced types. */
	inspectService(
		target: string | ServiceDefinitionAddress,
		options?: { readonly member?: string },
	): Promise<ControlServiceInspection>
}

/**
 * Open a build's control directory or a synchronized `current` directory.
 * The first inspection starts a declaration-only TypeScript session, reused until disposal.
 */
export async function openControl(root: string): Promise<ControlCatalog> {
	if (typeof root !== 'string' || !root.trim()) throw new TypeError('Expected a control directory')
	const directory = resolve(root)
	const catalog = await readControlCatalog(directory)
	type Entry =
		| PluginControlManifest['definitions'][number]
		| PluginControlManifest['services'][number]
	function byReference<T extends Entry>(entries: readonly T[]) {
		return new Map(
			entries.map((entry) => [formatPluginDefinitionReference(entry.definition), entry]),
		)
	}
	const plugins = byReference(catalog.manifest.definitions)
	const services = byReference(catalog.manifest.services)
	function declaration(entry: Entry) {
		return resolve(catalog.root, entry.module.slice(0, -4) + '.d.mts')
	}
	type Inspector = ReturnType<typeof createControlInspector>
	let inspector: Inspector | undefined
	let opening: Promise<Inspector> | undefined
	let closed = false
	function assertOpen() {
		if (closed) throw new Error('The control catalog has been disposed')
	}
	async function loadInspector() {
		const [{ createControlInspector }, files] = await Promise.all([
			import('./inspect-interface'),
			catalog.readDeclarations(),
		])
		assertOpen()
		inspector = createControlInspector({
			root: catalog.root,
			files,
			declarations: [...plugins.values(), ...services.values()].map(declaration),
		})
		return inspector
	}
	function select<T extends Entry>(
		index: ReadonlyMap<string, T>,
		kind: 'Plugin' | 'Service',
		target: string | PluginDefinitionAddress,
	) {
		assertOpen()
		const address =
			typeof target === 'string'
				? parsePluginDefinitionReference(target)
				: parsePluginDefinitionAddress(target)
		const reference = formatPluginDefinitionReference(address)
		const entry = index.get(reference)
		if (!entry) throw new RangeError(`${kind} is absent from this control material: ${reference}`)
		return { reference, entry }
	}
	function getInspector() {
		return (opening ??= loadInspector().catch((error) => {
			opening = undefined
			throw error
		}))
	}
	async function inspect(
		reference: string,
		entry: Entry,
		kind: 'plugin' | 'service',
		member?: string,
	) {
		if (member !== undefined && (typeof member !== 'string' || member.length === 0))
			throw new TypeError('Expected a non-empty control member name')
		const session = await getInspector()
		assertOpen()
		const api = session.inspect({
			declaration: declaration(entry),
			instanceExport: `${entry.exportName}Instance`,
			kind,
			member,
		})
		return {
			reference,
			exportName: entry.exportName,
			importStatement: `import { ${entry.exportName} } from ${JSON.stringify(resolve(directory, entry.module))};`,
			...api,
		}
	}
	return Object.freeze({
		root: catalog.root,
		snapshot: catalog.manifest.snapshot,
		plugins: Object.freeze(catalog.summaries.filter((entry) => entry.kind === 'plugin')),
		services: Object.freeze(catalog.summaries.filter((entry) => entry.kind === 'service')),
		async inspectConfig(target) {
			const { entry } = select(plugins, 'Plugin', target)
			if (entry.contracts.config === null) return null
			const session = await getInspector()
			assertOpen()
			return session.inspectConfig({
				declaration: declaration(entry),
				exportName: entry.exportName,
			})
		},
		async inspectPlugin(target, options = {}) {
			const { reference, entry } = select(plugins, 'Plugin', target)
			return {
				hasConfig: entry.contracts.config !== null,
				...(await inspect(reference, entry, 'plugin', options.member)),
			}
		},
		async inspectService(target, options = {}) {
			const { reference, entry } = select(services, 'Service', target)
			return {
				access: entry.access,
				...(await inspect(reference, entry, 'service', options.member)),
			}
		},
		[Symbol.dispose]() {
			if (closed) return
			closed = true
			const session = inspector
			inspector = undefined
			opening = undefined
			session?.[Symbol.dispose]()
		},
	} satisfies ControlCatalog)
}
