import {
	parsePluginDefinitionAddress,
	pluginDefinitionIndexKey,
	type PluginDefinitionAddress,
} from '@pluxel/core'

export type PluginControlDescriptorData = Readonly<{
	format: 2
	definition: PluginDefinitionAddress
	contracts: Readonly<{ config: string | null; instance: string }>
}>

export type PluginControlManifest = Readonly<{
	format: 2
	compiler: string
	snapshot: string
	definitions: readonly Readonly<{
		definition: PluginDefinitionAddress
		module: string
		exportName: string
		contracts: PluginControlDescriptorData['contracts']
		source: string
	}>[]
	files: readonly Readonly<{ path: string; size: number; sha256: string }>[]
}>

/** SHA-256 for UTF-8 control materials without a Node dependency. */
export async function controlSha256(content: string | Uint8Array): Promise<string> {
	const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes))
	return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/** Stable JSON encoding. Array order is meaningful; object property order is not. */
export function encodeControlData(value: unknown): string {
	if (value === null || typeof value !== 'object') return JSON.stringify(value)
	if (Array.isArray(value)) return `[${value.map(encodeControlData).join(',')}]`
	return `{${Object.keys(value)
		.sort()
		.map(
			(key) =>
				`${JSON.stringify(key)}:${encodeControlData((value as Record<string, unknown>)[key])}`,
		)
		.join(',')}}`
}

/** Deterministic provider template; its sole import is bound by the receiving framework. */
export function renderPluginDescriptors(
	descriptors: readonly Readonly<{ exportName: string; descriptor: PluginControlDescriptorData }>[],
): string {
	let factory = '__pluxel_control_reference'
	const names = new Set(descriptors.map(({ exportName }) => exportName))
	while (names.has(factory)) factory += '$'
	return (
		`import { createPluginControlReference as ${factory} } from '@pluxel/host/internal/control-reference';\n` +
		descriptors
			.map(({ exportName, descriptor }) => {
				if (!isControlExportName(exportName)) throw new TypeError('Invalid control export name')
				const parsed = parsePluginControlDescriptor(descriptor)
				return `export const ${exportName} = ${factory}(${encodeControlData(parsed)});\n`
			})
			.join('')
	)
}

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
	if (
		!value ||
		typeof value !== 'object' ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		throw new TypeError(`${label} must be a plain object`)
	const own = Reflect.ownKeys(value)
	if (
		own.length !== keys.length ||
		own.some((key) => typeof key !== 'string' || !keys.includes(key))
	)
		throw new TypeError(`${label} contains unexpected or missing fields`)
	for (const key of keys)
		if (!Object.hasOwn(value, key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))
			throw new TypeError(`${label}.${key} must be a data property`)
	return value as Record<string, unknown>
}

export function parsePluginControlDescriptor(value: unknown): PluginControlDescriptorData {
	const item = record(value, ['format', 'definition', 'contracts'], 'Control descriptor')
	if (item.format !== 2) throw new TypeError('Unsupported control descriptor format')
	const contracts = record(item.contracts, ['config', 'instance'], 'Control contracts')
	if (
		(contracts.config !== null && !isContract(contracts.config)) ||
		!isContract(contracts.instance)
	)
		throw new TypeError('Invalid control contract digest')
	return Object.freeze({
		format: 2,
		definition: parsePluginDefinitionAddress(item.definition),
		contracts: Object.freeze({
			config: contracts.config as string | null,
			instance: contracts.instance as string,
		}),
	})
}

const isContract = (value: unknown): value is string =>
	typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value)
const reservedControlNames = new Set(
	'arguments await break case catch class const continue debugger default delete do else enum eval export extends false finally for function if implements import in instanceof interface let new null package private protected public return static super switch this throw true try typeof var void while with yield'.split(
		' ',
	),
)
export const isControlExportName = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.length <= 256 &&
	/^[A-Za-z_$][\w$]*$/.test(value) &&
	!reservedControlNames.has(value)
export const isControlFilePath = (value: unknown): value is string =>
	typeof value === 'string' &&
	value.length <= 512 &&
	!value.includes('\\') &&
	!value.includes('\0') &&
	!value.startsWith('/') &&
	value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')

/** Parse untrusted material metadata before any path is opened or JavaScript is admitted. */
export function parsePluginControlManifest(value: unknown): PluginControlManifest {
	const item = record(
		value,
		['format', 'compiler', 'snapshot', 'definitions', 'files'],
		'Control manifest',
	)
	if (
		item.format !== 2 ||
		typeof item.compiler !== 'string' ||
		item.compiler.length > 256 ||
		!isContract(item.snapshot) ||
		!Array.isArray(item.definitions) ||
		item.definitions.length > 4096 ||
		!Array.isArray(item.files) ||
		item.files.length > 16384
	)
		throw new TypeError('Invalid control manifest')
	const names = new Set<string>(),
		identities = new Set<string>(),
		paths = new Set<string>()
	const definitions = item.definitions.map((raw) => {
		const entry = record(
			raw,
			['definition', 'module', 'exportName', 'contracts', 'source'],
			'Control definition',
		)
		const descriptor = parsePluginControlDescriptor({
			format: 2,
			definition: entry.definition,
			contracts: entry.contracts,
		})
		const module = entry.module
		if (
			!isControlFilePath(module) ||
			!module.endsWith('.mjs') ||
			!isControlExportName(entry.exportName) ||
			names.has(`${module}\0${entry.exportName}`) ||
			typeof entry.source !== 'string' ||
			entry.source.length > 1024
		)
			throw new TypeError('Invalid control definition export/source')
		const key = pluginDefinitionIndexKey(descriptor.definition)
		if (identities.has(key)) throw new TypeError('Duplicate control definition identity')
		names.add(`${module}\0${entry.exportName}`)
		identities.add(key)
		return Object.freeze({
			definition: descriptor.definition,
			module,
			exportName: entry.exportName,
			contracts: descriptor.contracts,
			source: entry.source,
		})
	})
	let total = 0
	const files = item.files.map((raw) => {
		const file = record(raw, ['path', 'size', 'sha256'], 'Control file')
		if (
			!isControlFilePath(file.path) ||
			file.path === 'manifest.json' ||
			paths.has(file.path) ||
			!Number.isSafeInteger(file.size) ||
			(file.size as number) < 0 ||
			(file.size as number) > 16 * 1024 * 1024 ||
			typeof file.sha256 !== 'string' ||
			!/^[a-f0-9]{64}$/.test(file.sha256)
		)
			throw new TypeError('Invalid control file entry')
		total += file.size as number
		paths.add(file.path)
		return Object.freeze({ path: file.path, size: file.size as number, sha256: file.sha256 })
	})
	if (
		total > 64 * 1024 * 1024 ||
		definitions.some(
			({ module }) => !paths.has(module) || !paths.has(module.slice(0, -4) + '.d.mts'),
		)
	)
		throw new TypeError('Control material is incomplete or exceeds its budget')
	const unsigned = { format: 2 as const, compiler: item.compiler, definitions, files }
	return Object.freeze({ ...unsigned, snapshot: item.snapshot as string })
}

/** Verify all files and every exact framework-generated executable module. */
export function verifyPluginControlMaterialSync(
	value: unknown,
	files: Readonly<Record<string, string>>,
	sha256: (content: string | Uint8Array) => string,
): PluginControlManifest {
	const manifest = parsePluginControlManifest(value)
	const { snapshot, ...unsigned } = manifest
	if (`sha256:${sha256(encodeControlData(unsigned))}` !== snapshot)
		throw new TypeError('Control manifest snapshot mismatch')
	const expected = new Set(['manifest.json', ...manifest.files.map((file) => file.path)])
	if (
		Object.keys(files).length !== expected.size ||
		Object.keys(files).some((path) => !expected.has(path))
	)
		throw new TypeError('Control material file set mismatch')
	for (const file of manifest.files) {
		const contents = files[file.path]
		if (
			typeof contents !== 'string' ||
			new TextEncoder().encode(contents).byteLength !== file.size ||
			sha256(contents) !== file.sha256
		)
			throw new TypeError(`Control file integrity mismatch: ${file.path}`)
	}
	if (files['manifest.json'] !== `${encodeControlData(manifest)}\n`)
		throw new TypeError('Control manifest file mismatch')
	const modules = new Map<string, PluginControlManifest['definitions'][number][]>()
	for (const entry of manifest.definitions) {
		const definitions = modules.get(entry.module) ?? []
		definitions.push(entry)
		modules.set(entry.module, definitions)
	}
	for (const file of manifest.files) {
		if (!file.path.endsWith('.mjs')) continue
		const definitions = modules.get(file.path)
		if (
			!definitions ||
			files[file.path] !==
				renderPluginDescriptors(
					definitions.map((entry) => ({
						exportName: entry.exportName,
						descriptor: { format: 2, definition: entry.definition, contracts: entry.contracts },
					})),
				)
		)
			throw new TypeError(
				`Control entry is not the deterministic provider emitter output: ${file.path}`,
			)
	}
	return manifest
}

export async function verifyPluginControlMaterial(
	value: unknown,
	files: Readonly<Record<string, string>>,
): Promise<PluginControlManifest> {
	const { snapshot: _snapshot, ...unsigned } = parsePluginControlManifest(value)
	const contents = [encodeControlData(unsigned), ...Object.values(files)]
	const digests = new Map(
		await Promise.all(
			contents.map(async (content) => [content, await controlSha256(content)] as const),
		),
	)
	return verifyPluginControlMaterialSync(value, files, (content) => {
		if (typeof content !== 'string' || !digests.has(content))
			throw new TypeError('Unexpected control digest input')
		return digests.get(content)!
	})
}
