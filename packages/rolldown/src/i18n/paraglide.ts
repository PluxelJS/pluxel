import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as files from 'node:fs/promises'
import { parseSync } from 'oxc-parser'
import { dirname, isAbsolute, relative, resolve } from 'pathe'

export const PLUXEL_PARAGLIDE_SETTINGS = 'project.inlang/settings.json'
export const PLUXEL_PARAGLIDE_OUTDIR = '.pluxel/i18n'

const MESSAGE_FORMAT_KEY = 'plugin.inlang.messageFormat'
const LOCALE_PLACEHOLDER = /\{(?:locale|languageTag)\}/g

export function isPluxelParaglideImport(specifier: string): boolean {
	return specifier === '#i18n' || specifier.startsWith('#i18n/')
}

export type PluxelParaglideProject = Readonly<{
	packageRoot: string
	settingsPath: string
	outdir: string
	/** Existing authored inputs, including the inlang settings file. */
	sources: readonly string[]
	/** Exact authored paths to observe, including files that have yet to be created. */
	watchFiles: readonly string[]
	/** Parent directories of inputs, which can be watched even when inputs are absent. */
	watchRoots: readonly string[]
	/** Matches configured inputs including files that have yet to be created. */
	matchesSource(file: string): boolean
}>

export type CompiledPluxelParaglideProject = PluxelParaglideProject &
	Readonly<{
		/** A fingerprint of package-relative paths and the input and output bytes. */
		fingerprint: string
	}>

type ProjectConfiguration = {
	packageRoot: string
	settingsPath: string
	outdir: string
	settings: Buffer
	messagePaths: readonly string[]
	sourcePaths: ReadonlySet<string>
	inputPaths: readonly string[]
}

const pending = new Map<string, Promise<CompiledPluxelParaglideProject | undefined>>()
const compiled = new Map<
	string,
	{ inputs: string; output: string; project: CompiledPluxelParaglideProject }
>()

/** Reads inputs for build watchers without loading inlang modules or parsing message files. */
export async function readPluxelParaglideProject(
	packageRoot: string,
): Promise<PluxelParaglideProject | undefined> {
	const config = await readProjectConfiguration(await files.realpath(packageRoot))
	if (!config) return undefined
	const existing = await Promise.all(
		[...config.sourcePaths].map(async (file) => {
			const status = await files.stat(file).catch(optionalMissingFile)
			return status?.isFile() ? file : undefined
		}),
	)
	return describeProject(
		config,
		existing.filter((file) => file !== undefined),
	)
}

/** Prepares the package's shared development and production output. */
export async function compilePluxelParaglide(
	packageRoot: string,
): Promise<CompiledPluxelParaglideProject | undefined> {
	const root = await files.realpath(packageRoot)
	const active = pending.get(root)
	if (active) return active
	const task = compilePackage(root)
	pending.set(root, task)
	try {
		return await task
	} finally {
		pending.delete(root)
	}
}

async function compilePackage(
	packageRoot: string,
): Promise<CompiledPluxelParaglideProject | undefined> {
	const config = await readProjectConfiguration(packageRoot)
	if (!config) {
		compiled.delete(packageRoot)
		return undefined
	}
	try {
		const inputs = new Map<string, Buffer | undefined>([[config.settingsPath, config.settings]])
		for (const file of config.inputPaths) {
			inputs.set(file, await files.readFile(file).catch(optionalMissingFile))
		}
		const inputsFingerprint = fingerprintFiles(packageRoot, inputs)
		const previousOutput = await readGeneratedFiles(config.outdir)
		const previous = compiled.get(packageRoot)
		if (
			previous?.inputs === inputsFingerprint &&
			previous.output === fingerprintFiles(config.outdir, previousOutput)
		) {
			return previous.project
		}

		const observed = new Set<string>()
		const catalogFs = createSnapshotFileSystem(inputs, observed)
		const { createCatalogLoader } = await import('@inlang/sdk/catalog')
		const catalog = await createCatalogLoader({
			path: dirname(config.settingsPath),
			fs: catalogFs,
		}).load()
		const importErrors = catalog.diagnostics.filter((error) => error.name === 'PluginImportError')
		if (importErrors.length > 0) {
			throw new AggregateError(importErrors, importErrors.map((error) => error.message).join('\n'))
		}
		if (catalog.type !== 'reset') throw new Error('Expected a fresh inlang catalog')
		if (!config.messagePaths.every((file) => observed.has(file))) {
			throw new Error(
				`An inlang module must load the message files declared in ${MESSAGE_FORMAT_KEY}.pathPattern; add @inlang/plugin-message-format to modules`,
			)
		}

		const { compileCatalog } = await import('@inlang/paraglide-js')
		const generated = await compileCatalog({
			catalog: { settings: catalog.settings, bundles: [...catalog.bundles] },
			projectPath: dirname(config.settingsPath),
			compilerOptions: {
				strategy: ['baseLocale'],
				disableAsyncLocalStorage: true,
				emitTsDeclarations: true,
				outputStructure: 'locale-modules',
				isDevelopment: 'false',
				emitGitIgnore: false,
				emitPrettierIgnore: false,
				emitReadme: false,
			},
		})
		for (const [file, source] of Object.entries(generated)) {
			if (file.startsWith('messages/') && file.endsWith('.js')) {
				generated[file] = removeMessageTypedefs(file, source)
			}
		}
		generated['index.js'] = indexJavaScript
		generated['index.d.ts'] = indexDeclaration
		generated['package.json'] = '{ "type": "module" }\n'
		await publishGeneratedFiles(config.outdir, generated, previousOutput)

		const outputFingerprint = fingerprintFiles(config.outdir, Object.entries(generated))
		const sources = [...config.sourcePaths].filter((file) => inputs.get(file) !== undefined)
		const project = Object.freeze({
			...describeProject(config, sources),
			fingerprint: createHash('sha256')
				.update(inputsFingerprint)
				.update(outputFingerprint)
				.digest('hex'),
		})
		compiled.set(packageRoot, { inputs: inputsFingerprint, output: outputFingerprint, project })
		return project
	} catch (cause) {
		compiled.delete(packageRoot)
		throw new Error(`[pluxel:i18n] Failed to compile ${config.settingsPath}: ${String(cause)}`, {
			cause,
		})
	}
}

async function readProjectConfiguration(
	packageRoot: string,
): Promise<ProjectConfiguration | undefined> {
	const root = resolve(packageRoot)
	const settingsPath = resolve(root, PLUXEL_PARAGLIDE_SETTINGS)
	const projectDir = dirname(settingsPath)
	const outdir = resolve(root, PLUXEL_PARAGLIDE_OUTDIR)
	const settings = await files.readFile(settingsPath).catch(optionalMissingFile)
	if (!settings) {
		const project = await files.stat(projectDir).catch(optionalMissingFile)
		if (!project) return undefined
		throw new Error(`[pluxel:i18n] Missing ${settingsPath}`)
	}

	try {
		const data: unknown = JSON.parse(settings.toString('utf8'))
		if (!isRecord(data)) throw new Error('Expected a JSON object')
		const { baseLocale, locales, modules } = data
		if (
			!isStringArray(locales) ||
			typeof baseLocale !== 'string' ||
			!locales.includes(baseLocale) ||
			locales.some((locale) => !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/i.test(locale))
		) {
			throw new Error('Expected locales to contain valid locale tags, including baseLocale')
		}
		const normalized = new Set(locales.map((locale) => locale.toLowerCase().replaceAll('_', '-')))
		if (normalized.size !== locales.length) throw new Error('Expected distinct locale tags')
		if (!isStringArray(modules) || modules.length === 0) {
			throw new Error('Expected modules to include @inlang/plugin-message-format')
		}
		const messageFormat = data[MESSAGE_FORMAT_KEY]
		const pathPattern = isRecord(messageFormat) ? messageFormat.pathPattern : undefined
		const patterns = typeof pathPattern === 'string' ? [pathPattern] : pathPattern
		if (
			!isStringArray(patterns) ||
			patterns.length === 0 ||
			patterns.some(
				(pattern) =>
					!/\{(?:locale|languageTag)\}/.test(pattern) ||
					!pattern.endsWith('.json') ||
					/[*?]/.test(pattern),
			)
		) {
			throw new Error(
				`Expected ${MESSAGE_FORMAT_KEY}.pathPattern to be a JSON file path or an array of JSON file paths containing {locale}; list each split catalog explicitly`,
			)
		}
		const messagePaths = [
			...new Set(
				patterns.flatMap((pattern) =>
					locales.map((locale) => resolve(root, pattern.replaceAll(LOCALE_PLACEHOLDER, locale))),
				),
			),
		].sort()
		if (messagePaths.some((file) => isWithin(outdir, file))) {
			throw new Error(
				`Message files must live outside the generated ${PLUXEL_PARAGLIDE_OUTDIR} directory`,
			)
		}
		const descriptions = resolve(projectDir, 'descriptions.json')
		const localModules = modules
			.filter((module) => !module.startsWith('http'))
			.map((module) => resolve(root, module))
		const sourcePaths = new Set([
			settingsPath,
			descriptions,
			...messagePaths,
			...localModules.filter((file) => !file.split('/').includes('node_modules')),
		])
		const inputPaths = [...new Set([descriptions, ...messagePaths, ...localModules])]
		return {
			packageRoot: root,
			settingsPath,
			outdir,
			settings,
			messagePaths,
			sourcePaths,
			inputPaths,
		}
	} catch (cause) {
		throw new Error(`[pluxel:i18n] Invalid ${settingsPath}: ${String(cause)}`, { cause })
	}
}

function describeProject(config: ProjectConfiguration, sources: string[]): PluxelParaglideProject {
	return Object.freeze({
		packageRoot: config.packageRoot,
		settingsPath: config.settingsPath,
		outdir: config.outdir,
		sources: Object.freeze(sources.sort()),
		watchFiles: Object.freeze([...config.sourcePaths].sort()),
		watchRoots: Object.freeze([...new Set([...config.sourcePaths].map(dirname))].sort()),
		matchesSource: (file: string) => config.sourcePaths.has(resolve(file)),
	})
}

function createSnapshotFileSystem(
	inputs: ReadonlyMap<string, Buffer | undefined>,
	observed: Set<string>,
): typeof fs {
	// The SDK reads the same settings and resource bytes used for the revision.
	const readFile = async (
		file: fs.PathLike | files.FileHandle,
		options?: BufferEncoding | { encoding?: BufferEncoding | null } | null,
	) => {
		const path = typeof file === 'string' ? resolve(file) : undefined
		if (!path || !inputs.has(path)) return files.readFile(file, options ?? null)
		observed.add(path)
		const contents = inputs.get(path)
		if (!contents) throw Object.assign(new Error(`No such file: ${path}`), { code: 'ENOENT' })
		const encoding = typeof options === 'string' ? options : options?.encoding
		return encoding ? contents.toString(encoding) : Buffer.from(contents)
	}
	return { ...fs, promises: { ...files, readFile: readFile as typeof files.readFile } }
}

function isWithin(directory: string, file: string): boolean {
	const path = relative(directory, file)
	return path !== '..' && !path.startsWith('../') && !isAbsolute(path)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
	)
}

function optionalMissingFile(error: NodeJS.ErrnoException): undefined {
	if (error.code !== 'ENOENT') throw error
	return undefined
}

function fingerprintFiles(
	root: string,
	entries: Iterable<readonly [string, string | Buffer | undefined]>,
): string {
	const hash = createHash('sha256')
	const namesAndHashes = [...entries].map(
		([file, content]) =>
			[
				relative(root, resolve(root, file)),
				content === undefined ? null : createHash('sha256').update(content).digest('hex'),
			] as const,
	)
	namesAndHashes.sort(([a], [b]) => (a < b ? -1 : a === b ? 0 : 1))
	return hash.update(JSON.stringify(namesAndHashes)).digest('hex')
}

function removeMessageTypedefs(file: string, source: string): string {
	// Declarations carry these types. Keeping per-message typedefs in grouped JS
	// would retain unused messages' annotations in unminified bundles.
	const parts: string[] = []
	let cursor = 0
	for (const comment of parseSync(file, source, { sourceType: 'module' }).comments) {
		if (!comment.value.trimStart().startsWith('* @typedef')) continue
		parts.push(source.slice(cursor, comment.start))
		cursor = comment.end
	}
	parts.push(source.slice(cursor))
	return parts.join('')
}

async function readGeneratedFiles(outdir: string): Promise<Map<string, string>> {
	const entries = await files
		.readdir(outdir, { recursive: true, withFileTypes: true })
		.catch(optionalMissingFile)
	const output = new Map<string, string>()
	for (const entry of entries ?? []) {
		if (entry.isDirectory()) continue
		const file = resolve(entry.parentPath, entry.name)
		const contents = await files.readFile(file, 'utf8').catch(optionalMissingFile)
		if (contents !== undefined) output.set(relative(outdir, file), contents)
	}
	return output
}

async function publishGeneratedFiles(
	outdir: string,
	generated: Record<string, string>,
	previous: ReadonlyMap<string, string>,
): Promise<void> {
	const changed = Object.entries(generated).filter(
		([file, contents]) => previous.get(file) !== contents,
	)
	const stale = [...previous.keys()].filter((file) => !Object.hasOwn(generated, file))
	if (changed.length > 0) {
		const parent = dirname(outdir)
		await files.mkdir(parent, { recursive: true })
		const stage = await files.mkdtemp(resolve(parent, 'i18n-write-'))
		try {
			const { writeOutput } = await import('@inlang/paraglide-js')
			await writeOutput({ directory: stage, output: Object.fromEntries(changed), fs: files })
			for (const [file] of changed) {
				const destination = resolve(outdir, file)
				await files.mkdir(dirname(destination), { recursive: true })
				await files.rename(resolve(stage, file), destination)
			}
		} finally {
			await files.rm(stage, { recursive: true, force: true })
		}
	}
	for (const file of stale) await files.rm(resolve(outdir, file), { force: true })
}

const indexJavaScript = `import { baseLocale, isLocale, locales } from './runtime.js'

export { m } from './messages.js'
export { baseLocale, isLocale, locales }

function normalizeLocale(locale) {
	return locale.trim().replaceAll('_', '-').toLowerCase()
}

const normalizedLocales = new Map(locales.map((locale) => [normalizeLocale(locale), locale]))

export function resolveLocale(requested) {
	if (requested == null) return baseLocale
	if (isLocale(requested)) return requested
	let candidate = normalizeLocale(requested)
	while (candidate) {
		const locale = normalizedLocales.get(candidate)
		if (locale !== undefined) return locale
		const separator = candidate.lastIndexOf('-')
		if (separator === -1) break
		candidate = candidate.slice(0, separator)
	}
	return baseLocale
}
`

const indexDeclaration = `import type { Locale } from './runtime.js'

export { m } from './messages.js'
export { baseLocale, isLocale, locales } from './runtime.js'
export type { Locale }

/** Finds the closest supported locale, using the project base locale as the fallback. */
export declare function resolveLocale(requested?: string | null): Locale
`
