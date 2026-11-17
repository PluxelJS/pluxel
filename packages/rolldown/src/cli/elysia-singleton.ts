import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'pathe'
import type { Plugin, PluginContext, ResolvedId } from 'rolldown'

const SERVICES_PACKAGE_MANIFEST = '@pluxel/services/package.json'
const ELYSIA_PACKAGE_MANIFEST = 'elysia/package.json'
const STATIC_ELYSIA_WIRING_ID = 'pluxel:static-elysia-wiring'
const RESOLVED_STATIC_ELYSIA_WIRING_ID = `\0${STATIC_ELYSIA_WIRING_ID}`
const STATIC_ELYSIA_ENTRY_PREFIX = '\0pluxel:static-elysia-entry:'
const STATIC_ELYSIA_RESOLVE_FILTER =
	/^(?:pluxel:static-elysia-wiring|(?:elysia|typebox|exact-mirror)(?:\/[^?#]+)?)$/

/**
 * Resolves every public Elysia runtime entry through the copy owned by Pluxel HTTP.
 *
 * Source-linked applications can otherwise expose separate physical pnpm paths for Services and
 * Plugin imports even when both declare the same exact version. A static application must bundle
 * one Elysia identity for its application, adapters, schemas and WebSocket capability.
 */
export function staticElysiaSingletonPlugin(cwd: string): Plugin {
	let installation: Promise<ElysiaInstallation | undefined> | undefined
	const canonicalResolutions = new Map<string, Promise<ResolvedId>>()
	const resolveInstallation = (context: PluginContext) =>
		(installation ??= findElysiaInstallation(context, cwd))

	return {
		name: 'pluxel:static-elysia-singleton',
		buildStart() {
			installation = undefined
			canonicalResolutions.clear()
		},
		resolveId: {
			filter: { id: STATIC_ELYSIA_RESOLVE_FILTER },
			async handler(id, importer, options) {
				if (id === STATIC_ELYSIA_WIRING_ID) return RESOLVED_STATIC_ELYSIA_WIRING_ID
				if (id === ELYSIA_PACKAGE_MANIFEST) return null
				const runtime = await resolveInstallation(this)
				if (!runtime) {
					if (id === 'elysia' || id.startsWith('elysia/'))
						this.error(
							`[static-application] Cannot resolve Elysia owned by ${SERVICES_PACKAGE_MANIFEST} from ${cwd}`,
						)
					// Standalone TypeBox users do not require the optional HTTP installation.
					return null
				}
				const publicEntry = runtime.publicSpecifiers.has(id)
				const canonicalImporter = publicEntry
					? runtime.servicesManifest
					: id === 'typebox' ||
						  id.startsWith('typebox/') ||
						  id === 'exact-mirror' ||
						  id.startsWith('exact-mirror/')
						? runtime.elysiaManifest
						: null
				if (!canonicalImporter) return null

				let resolution = canonicalResolutions.get(id)
				if (!resolution) {
					resolution = this.resolve(id, canonicalImporter, {
						...options,
						skipSelf: true,
					}).then((resolved) => {
						const canonical = requireAbsoluteResolution(this, resolved, id, canonicalImporter)
						return { ...resolved, id: canonical, external: false }
					})
					canonicalResolutions.set(id, resolution)
				}
				const canonical = await resolution
				if (!publicEntry || importer === RESOLVED_STATIC_ELYSIA_WIRING_ID) return canonical
				return { id: `${STATIC_ELYSIA_ENTRY_PREFIX}${canonical.id}`, moduleSideEffects: true }
			},
		},
		async load(id) {
			if (id === RESOLVED_STATIC_ELYSIA_WIRING_ID) return buildStaticElysiaWiring()
			if (!id.startsWith(STATIC_ELYSIA_ENTRY_PREFIX)) return null
			const entry = id.slice(STATIC_ELYSIA_ENTRY_PREFIX.length)
			const module = await this.load({ id: entry })
			// Import ordering belongs to this Elysia entry, including dynamic imports.
			// Read the real module's exports rather than inventing a default on subpaths.
			return `import ${JSON.stringify(STATIC_ELYSIA_WIRING_ID)}\nexport * from ${JSON.stringify(entry)}\n${module.exports.includes('default') ? `export { default } from ${JSON.stringify(entry)}` : ''}`
		},
	}
}

type ElysiaInstallation = {
	servicesManifest: string
	elysiaManifest: string
	publicSpecifiers: ReadonlySet<string>
}

async function findElysiaInstallation(
	context: PluginContext,
	cwd: string,
): Promise<ElysiaInstallation | undefined> {
	const applicationManifest = resolve(cwd, 'package.json')
	const services = await context.resolve(SERVICES_PACKAGE_MANIFEST, applicationManifest, {
		skipSelf: true,
	})
	if (!services) return undefined
	const servicesManifest = requireAbsoluteResolution(
		context,
		services,
		SERVICES_PACKAGE_MANIFEST,
		applicationManifest,
	)
	const elysia = await context.resolve(ELYSIA_PACKAGE_MANIFEST, servicesManifest, {
		skipSelf: true,
	})
	if (!elysia) return undefined
	const elysiaManifest = requireAbsoluteResolution(
		context,
		elysia,
		ELYSIA_PACKAGE_MANIFEST,
		servicesManifest,
	)
	const publicSpecifiers = readPublicElysiaSpecifiers(
		JSON.parse(await readFile(elysiaManifest, 'utf8')) as unknown,
	)
	if (!publicSpecifiers.has('elysia'))
		context.error('[static-application] host Elysia package does not export its root entry')
	return { servicesManifest, elysiaManifest, publicSpecifiers }
}

function buildStaticElysiaWiring(): string {
	return `
import { setupTypebox as __setupTypebox } from 'elysia'
import __exactMirror from 'exact-mirror'
import * as __typeboxCompile from 'typebox/compile'
import * as __typeboxSchema from 'typebox/schema'
import * as __typeboxSystem from 'typebox/system'
import * as __typeboxType from 'typebox/type'
import * as __typeboxValue from 'typebox/value'
__setupTypebox({
	exactMirror: __exactMirror,
	typebox: {
		compile: __typeboxCompile,
		schema: __typeboxSchema,
		system: __typeboxSystem,
		type: __typeboxType,
		value: __typeboxValue,
	},
})
`
}

export function readPublicElysiaSpecifiers(manifest: unknown): Set<string> {
	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
		throw new TypeError('[static-application] host Elysia package manifest is invalid')
	}
	const exportsValue = (manifest as { exports?: unknown }).exports
	if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) {
		throw new TypeError('[static-application] host Elysia package exports are missing')
	}

	const specifiers = new Set<string>()
	for (const key of Object.keys(exportsValue)) {
		if (key === '.') specifiers.add('elysia')
		else if (key.startsWith('./') && key !== './package.json' && !key.includes('*')) {
			specifiers.add(`elysia/${key.slice(2)}`)
		}
	}
	return specifiers
}

function requireAbsoluteResolution(
	context: { error(message: string): never },
	resolved: ResolvedId | null,
	specifier: string,
	importer: string,
): string {
	const id = resolved?.id.split('?', 1)[0]
	if (!id || !isAbsolute(id)) {
		context.error(
			`[static-application] ${JSON.stringify(specifier)} cannot be resolved from ${importer}`,
		)
	}
	return id
}
