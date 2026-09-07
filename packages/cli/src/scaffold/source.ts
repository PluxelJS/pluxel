import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isAbsolute, resolve } from 'pathe'
import { scaffoldError } from './errors'
import { resolveTemplatesDir } from './utils'

export type TemplateSource = { kind: 'bundled'; name: string } | { kind: 'local'; path: string }

export type TemplateProvenance = { kind: 'bundled'; name: string } | { kind: 'local'; path: string }

export type AcquiredTemplate = {
	root: string
	provenance: TemplateProvenance
	dispose(): Promise<void>
}

type DirentLike = { name: string; isDirectory?: () => boolean }

export function listBundledTemplates(
	fileSystem: typeof fs = fs,
	templatesDir = resolveTemplatesDir(),
): string[] {
	if (!fileSystem.existsSync(templatesDir)) return []
	try {
		return (fileSystem.readdirSync(templatesDir, { withFileTypes: true }) as DirentLike[])
			.filter((entry) => entry.isDirectory?.() === true && !entry.name.startsWith('.'))
			.map((entry) => entry.name)
			.sort((left, right) => left.localeCompare(right))
	} catch {
		return []
	}
}

export function parseTemplateSource(input: string, options: { cwd?: string } = {}): TemplateSource {
	const value = input.trim()
	if (!value) {
		throw scaffoldError('TEMPLATE_NOT_FOUND', 'Template source is empty.')
	}

	if (value.startsWith('file:')) {
		let path: string
		try {
			path = fileURLToPath(value)
		} catch (error) {
			throw scaffoldError('TEMPLATE_NOT_FOUND', `Invalid local template URL: ${value}`, error)
		}
		return { kind: 'local', path: resolve(path) }
	}

	if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
		return { kind: 'local', path: resolve(value) }
	}
	if (
		value === '.' ||
		value === '..' ||
		value.startsWith('./') ||
		value.startsWith('../') ||
		value.startsWith('.\\') ||
		value.startsWith('..\\')
	) {
		return { kind: 'local', path: resolve(options.cwd ?? process.cwd(), value) }
	}
	if (value.includes('/') || value.includes('\\') || value.includes(':')) {
		throw scaffoldError(
			'TEMPLATE_NOT_FOUND',
			`Unsupported template source: ${value}. Use a bundled name, ./local/path, an absolute path, or file: URL.`,
		)
	}
	return { kind: 'bundled', name: value }
}

export async function acquireTemplate(
	source: TemplateSource,
	options: { fs?: typeof fs; templatesDir?: string } = {},
): Promise<AcquiredTemplate> {
	const fileSystem = options.fs ?? fs
	const templatesDir = options.templatesDir ?? resolveTemplatesDir()
	const root = source.kind === 'bundled' ? resolve(templatesDir, source.name) : source.path

	if (!fileSystem.existsSync(root)) {
		const available = listBundledTemplates(fileSystem, templatesDir)
		const hint =
			source.kind === 'bundled' && available.length > 0
				? ` Available bundled templates: ${available.join(', ')}.`
				: ''
		throw scaffoldError('TEMPLATE_NOT_FOUND', `Template not found: ${root}.${hint}`)
	}

	let stats: fs.Stats
	try {
		stats = fileSystem.lstatSync(root)
	} catch (error) {
		throw scaffoldError('TEMPLATE_NOT_FOUND', `Cannot inspect template: ${root}`, error)
	}
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw scaffoldError('TEMPLATE_CONTRACT_INVALID', `Template root must be a directory: ${root}`)
	}

	return {
		root,
		provenance:
			source.kind === 'bundled'
				? { kind: 'bundled', name: source.name }
				: { kind: 'local', path: root },
		async dispose() {},
	}
}

export function formatTemplateProvenance(provenance: TemplateProvenance): string {
	return provenance.kind === 'bundled' ? provenance.name : provenance.path
}
