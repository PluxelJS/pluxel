import fs from 'node:fs'
import { isAbsolute, relative, resolve } from 'pathe'
import type { PM } from '../utils/pm'
import { TEMPLATE_MANIFEST, type TemplateContract } from './contract'
import { scaffoldError } from './errors'
import { renderTemplateValue } from './render'
import type { TemplateProvenance } from './source'

const TEMPLATE_EXTENSION = '.tpl'
const LEGACY_CONTROL_FILES = new Set([
	'prompts.json',
	'prompts.jsonc',
	'pluxel-docs.json',
	'pluxel-docs.jsonc',
])

type DirentLike = {
	name: string
	isDirectory?: () => boolean
	isFile?: () => boolean
	isSymbolicLink?: () => boolean
}

export type PlannedOutput = Readonly<{
	relativePath: string
	absolutePath: string
	contents: Uint8Array
	source: string
	existed: boolean
}>

export type ScaffoldPlan = Readonly<{
	template: TemplateProvenance
	templateId: string
	targetDir: string
	outputs: readonly PlannedOutput[]
	existing: readonly string[]
	overwrite: readonly string[]
	install: boolean
	packageManager?: PM
}>

export async function compileScaffoldPlan(params: {
	templateRoot: string
	template: TemplateProvenance
	contract: TemplateContract
	targetDir: string
	data: Readonly<Record<string, string>>
	force: boolean
	install: boolean
	packageManager?: PM
	fs?: typeof fs
}): Promise<ScaffoldPlan> {
	const fileSystem = params.fs ?? fs
	const templateFiles = await walkRegularFiles(params.templateRoot, fileSystem, 'template')
	const outputs: PlannedOutput[] = []

	for (const templatePath of templateFiles) {
		const sourceRelativePath = relative(params.templateRoot, templatePath)
		if (sourceRelativePath === TEMPLATE_MANIFEST) continue
		if (LEGACY_CONTROL_FILES.has(sourceRelativePath) || sourceRelativePath.endsWith('.hbs')) {
			throw scaffoldError(
				'TEMPLATE_CONTRACT_INVALID',
				`Legacy template file is not supported: ${sourceRelativePath}. Migrate control data to ${TEMPLATE_MANIFEST} and rendered files to .tpl.`,
			)
		}
		const renderedSourcePath = renderTemplateValue(
			sourceRelativePath,
			params.data,
			`template path (${sourceRelativePath})`,
		)
		const renderedPath = renderedSourcePath.endsWith(TEMPLATE_EXTENSION)
			? renderedSourcePath.slice(0, -TEMPLATE_EXTENSION.length)
			: renderedSourcePath
		const relativePath = validateOutputPath(renderedPath, sourceRelativePath)
		const raw = asBytes(await fileSystem.promises.readFile(templatePath))
		const contents = templatePath.endsWith(TEMPLATE_EXTENSION)
			? Buffer.from(
					renderTemplateValue(
						decodeUtf8(raw, templatePath),
						params.data,
						`template file (${templatePath})`,
					),
					'utf8',
				)
			: raw
		outputs.push(
			createPlannedOutput(relativePath, contents, templatePath, params.targetDir, fileSystem),
		)
	}

	if (outputs.length === 0) {
		throw scaffoldError(
			'TEMPLATE_CONTRACT_INVALID',
			`Template has no output files: ${params.templateRoot}`,
		)
	}
	assertNoOutputCollisions(outputs)
	assertTargetParents(params.targetDir, outputs, fileSystem)

	const sortedOutputs = outputs.sort((left, right) =>
		left.relativePath.localeCompare(right.relativePath),
	)
	const existing = sortedOutputs
		.filter((output) => output.existed)
		.map((output) => output.relativePath)
	return Object.freeze({
		template: Object.freeze({ ...params.template }),
		templateId: params.contract.id,
		targetDir: params.targetDir,
		outputs: Object.freeze(sortedOutputs),
		existing: Object.freeze(existing),
		overwrite: Object.freeze(params.force ? [...existing] : []),
		install: params.install,
		...(params.packageManager ? { packageManager: params.packageManager } : {}),
	})
}

export function authorizePlanOverwrite(plan: ScaffoldPlan): ScaffoldPlan {
	return Object.freeze({ ...plan, overwrite: Object.freeze([...plan.existing]) })
}

function createPlannedOutput(
	relativePath: string,
	contents: Uint8Array,
	source: string,
	targetDir: string,
	fileSystem: typeof fs,
): PlannedOutput {
	const absolutePath = resolve(targetDir, relativePath)
	const rel = relative(targetDir, absolutePath)
	if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
		throw scaffoldError(
			'TEMPLATE_RENDER_INVALID',
			`Template output escapes the target directory: ${relativePath}`,
		)
	}
	let existed = false
	if (fileSystem.existsSync(absolutePath)) {
		const stats = fileSystem.lstatSync(absolutePath)
		if (stats.isSymbolicLink() || !stats.isFile()) {
			throw scaffoldError(
				'TARGET_CONFLICT',
				`Target contains a non-file at output path: ${relativePath}`,
			)
		}
		existed = true
	}
	return Object.freeze({
		relativePath,
		absolutePath,
		contents: Uint8Array.from(contents),
		source,
		existed,
	})
}

async function walkRegularFiles(
	root: string,
	fileSystem: typeof fs,
	label: string,
): Promise<string[]> {
	const outputs: string[] = []
	const visit = async (directory: string) => {
		const entries = (await fileSystem.promises.readdir(directory, {
			withFileTypes: true,
		})) as DirentLike[]
		for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
			const path = resolve(directory, entry.name)
			if (entry.isSymbolicLink?.()) {
				throw scaffoldError(
					'TEMPLATE_CONTRACT_INVALID',
					`${label} contains a symbolic link: ${relative(root, path)}`,
				)
			}
			if (entry.isDirectory?.()) {
				await visit(path)
				continue
			}
			if (entry.isFile?.() === false) {
				throw scaffoldError(
					'TEMPLATE_CONTRACT_INVALID',
					`${label} contains a non-regular file: ${relative(root, path)}`,
				)
			}
			outputs.push(path)
		}
	}
	await visit(root)
	return outputs
}

function validateOutputPath(path: string, source: string): string {
	const normalized = path.replaceAll('\\', '/').normalize('NFC')
	if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
		throw scaffoldError('TEMPLATE_RENDER_INVALID', `Invalid output path from ${source}: ${path}`)
	}
	const segments = normalized.split('/')
	if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
		throw scaffoldError('TEMPLATE_RENDER_INVALID', `Invalid output path from ${source}: ${path}`)
	}
	for (const segment of segments) {
		const stem = segment.split('.')[0]!.toUpperCase()
		if (
			/[<>:"|?*\u0000-\u001F]/.test(segment) ||
			/[ .]$/.test(segment) ||
			/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
		) {
			throw scaffoldError(
				'TEMPLATE_RENDER_INVALID',
				`Output path is not portable across supported platforms: ${path}`,
			)
		}
	}
	return normalized
}

function assertNoOutputCollisions(outputs: readonly PlannedOutput[]) {
	const byPortablePath = new Map<string, PlannedOutput>()
	for (const output of outputs) {
		const key = output.relativePath.normalize('NFC').toLowerCase()
		const previous = byPortablePath.get(key)
		if (previous) {
			throw scaffoldError(
				'TEMPLATE_OUTPUT_CONFLICT',
				`Template outputs collide at ${output.relativePath}: ${previous.source} and ${output.source}`,
			)
		}
		byPortablePath.set(key, output)
	}
	for (const path of byPortablePath.keys()) {
		const segments = path.split('/')
		for (let index = 1; index < segments.length; index += 1) {
			const parent = segments.slice(0, index).join('/')
			if (!byPortablePath.has(parent)) continue
			throw scaffoldError(
				'TEMPLATE_OUTPUT_CONFLICT',
				`Template output is both a file and a directory: ${parent}`,
			)
		}
	}
}

function assertTargetParents(
	targetDir: string,
	outputs: readonly PlannedOutput[],
	fileSystem: typeof fs,
) {
	if (fileSystem.existsSync(targetDir)) {
		const stats = fileSystem.lstatSync(targetDir)
		if (stats.isSymbolicLink() || !stats.isDirectory()) {
			throw scaffoldError('TARGET_CONFLICT', `Scaffold target must be a directory: ${targetDir}`)
		}
	}
	const checked = new Set<string>()
	for (const output of outputs) {
		const segments = output.relativePath.split('/')
		for (let index = 1; index < segments.length; index += 1) {
			const relativeParent = segments.slice(0, index).join('/')
			if (checked.has(relativeParent)) continue
			checked.add(relativeParent)
			const parent = resolve(targetDir, relativeParent)
			if (!fileSystem.existsSync(parent)) continue
			const stats = fileSystem.lstatSync(parent)
			if (stats.isSymbolicLink() || !stats.isDirectory()) {
				throw scaffoldError(
					'TARGET_CONFLICT',
					`Target contains a non-directory at parent path: ${relativeParent}`,
				)
			}
		}
	}
}

function asBytes(value: string | Buffer): Uint8Array {
	return typeof value === 'string' ? Buffer.from(value) : Uint8Array.from(value)
}

function decodeUtf8(value: Uint8Array, path: string): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(value)
	} catch (error) {
		throw scaffoldError('TEMPLATE_RENDER_INVALID', `.tpl file is not valid UTF-8: ${path}`, error)
	}
}
