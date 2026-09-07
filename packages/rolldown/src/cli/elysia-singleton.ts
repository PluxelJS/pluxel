import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'pathe'
import type { Plugin, ResolvedId } from 'rolldown'

const RUNTIME_PACKAGE_MANIFEST = '@pluxel/runtime/package.json'
const ELYSIA_PACKAGE_MANIFEST = 'elysia/package.json'
const STATIC_ELYSIA_WIRING_ID = 'pluxel:static-elysia-wiring'
const RESOLVED_STATIC_ELYSIA_WIRING_ID = `\0${STATIC_ELYSIA_WIRING_ID}`
const TYPEBOX_RUNTIME_SPECIFIERS = new Set([
	'typebox/compile',
	'typebox/schema',
	'typebox/system',
	'typebox/type',
	'typebox/value',
])
const EXACT_MIRROR_SPECIFIER = 'exact-mirror'
const STATIC_ELYSIA_RESOLVE_FILTER =
	/^(?:pluxel:static-elysia-wiring|elysia(?:\/[^?#]+)?|typebox\/(?:compile|schema|system|type|value)|exact-mirror)$/

/**
 * Resolves every public Elysia runtime entry through the copy owned by Pluxel Runtime.
 *
 * Source-linked applications can otherwise expose separate physical pnpm paths for Runtime and
 * Plugin imports even when both declare the same exact version. A static application must bundle
 * one Elysia identity for its application, adapters, schemas and WebSocket capability.
 */
export function staticElysiaSingletonPlugin(cwd: string): Plugin {
	let runtimeManifest = ''
	let elysiaManifest = ''
	let publicSpecifiers = new Set<string>()
	const canonicalResolutions = new Map<string, Promise<ResolvedId>>()

	return {
		name: 'pluxel:static-elysia-singleton',
		async buildStart() {
			canonicalResolutions.clear()
			const applicationManifest = resolve(cwd, 'package.json')
			const runtime = await this.resolve(RUNTIME_PACKAGE_MANIFEST, applicationManifest, {
				skipSelf: true,
			})
			runtimeManifest = requireAbsoluteResolution(
				this,
				runtime,
				RUNTIME_PACKAGE_MANIFEST,
				applicationManifest,
			)

			const elysia = await this.resolve(ELYSIA_PACKAGE_MANIFEST, runtimeManifest, {
				skipSelf: true,
			})
			elysiaManifest = requireAbsoluteResolution(
				this,
				elysia,
				ELYSIA_PACKAGE_MANIFEST,
				runtimeManifest,
			)
			publicSpecifiers = readPublicElysiaSpecifiers(
				JSON.parse(await readFile(elysiaManifest, 'utf8')) as unknown,
			)
			if (!publicSpecifiers.has('elysia')) {
				this.error('[static-application] host Elysia package does not export its root entry')
			}
		},
		resolveId: {
			filter: { id: STATIC_ELYSIA_RESOLVE_FILTER },
			handler(id, _importer, options) {
				if (id === STATIC_ELYSIA_WIRING_ID) return RESOLVED_STATIC_ELYSIA_WIRING_ID
				const canonicalImporter = publicSpecifiers.has(id)
					? runtimeManifest
					: TYPEBOX_RUNTIME_SPECIFIERS.has(id) || id === EXACT_MIRROR_SPECIFIER
						? elysiaManifest
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
				return resolution
			},
		},
		load(id) {
			if (id !== RESOLVED_STATIC_ELYSIA_WIRING_ID) return null
			return buildStaticElysiaWiring()
		},
	}
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
