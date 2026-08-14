import fs from 'node:fs'
import { cancel, confirm, isCancel, select, text } from '@clack/prompts'
import { dirname, isAbsolute, relative, resolve } from 'pathe'
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser'
import { capitalize, kebabCase, pascalCase } from './name.ts'
import { resolveTemplatesDir, resolveUserDocsDir } from './utils.ts'

const TEMPLATE_PROMPT_FILES = new Set(['prompts.json', 'prompts.jsonc'])
const USER_DOCS_CONFIG_FILES = new Set(['user-docs.json', 'user-docs.jsonc'])
const TEMPLATE_CONTROL_FILES = new Set([...TEMPLATE_PROMPT_FILES, ...USER_DOCS_CONFIG_FILES])
const TEMPLATE_EXT = '.hbs'

const TEMPLATE_REGEX = /{{\s*([a-zA-Z][\w]*)\s+([a-zA-Z0-9_]+)\s*}}|{{\s*([a-zA-Z0-9_]+)\s*}}/g

type TemplateDirentLike = {
	name: string
	isDirectory?: () => boolean
}

function getTemplateDirentName(entry: string | TemplateDirentLike): string {
	return typeof entry === 'string' ? entry : entry.name
}

function isTemplateDirectory(
	fileSystem: typeof fs,
	parentDir: string,
	entry: string | TemplateDirentLike,
): boolean {
	if (typeof entry !== 'string') return entry.isDirectory?.() === true
	try {
		return fileSystem.statSync(resolve(parentDir, entry)).isDirectory()
	} catch {
		return false
	}
}

async function walkTemplateFiles(rootDir: string, fileSystem: typeof fs): Promise<string[]> {
	const out: string[] = []
	const visit = async (dir: string) => {
		const entries = (await fileSystem.promises.readdir(dir, {
			withFileTypes: true,
		})) as Array<string | TemplateDirentLike>
		for (const entry of entries) {
			const name = getTemplateDirentName(entry)
			const path = resolve(dir, name)
			if (isTemplateDirectory(fileSystem, dir, entry)) {
				await visit(path)
				continue
			}
			out.push(path)
		}
	}

	await visit(rootDir)
	return out.sort((a, b) => a.localeCompare(b))
}

function listKnownTemplates(fileSystem: typeof fs = fs, base = resolveTemplatesDir()): string[] {
	if (!fileSystem.existsSync(base)) return []
	try {
		return fileSystem
			.readdirSync(base, { withFileTypes: true })
			.filter((entry) =>
				isTemplateDirectory(fileSystem, base, entry as string | TemplateDirentLike),
			)
			.map((entry) => getTemplateDirentName(entry as string | TemplateDirentLike))
			.filter((name) => !name.startsWith('.'))
			.sort((a, b) => a.localeCompare(b))
	} catch {
		return []
	}
}

export async function ensureTemplate(
	explicit?: string,
	options: { fs?: typeof fs; templatesDir?: string } = {},
): Promise<string | undefined> {
	const normalized = typeof explicit === 'string' ? explicit.trim() : ''
	if (normalized) return normalized
	const fileSystem = options.fs ?? fs
	const templatesDir = options.templatesDir ?? resolveTemplatesDir()

	const known = listKnownTemplates(fileSystem, templatesDir)
	if (known.length === 0) {
		throw new Error(`No templates found under ${templatesDir}`)
	}

	if (!isInteractive()) {
		if (known.length === 1) return known[0]!
		if (known.includes('plugin')) return 'plugin'
		return known[0]!
	}

	if (known.length === 1) return known[0]!

	const custom = '__custom__'
	const picked = await select({
		message: 'Template',
		options: [
			...known.map((t) => ({ value: t, label: t })),
			{
				value: custom,
				label: 'Custom...',
				hint: 'Enter template name or a path',
			},
		],
		initialValue: known.includes('plugin') ? 'plugin' : known[0]!,
	})
	if (isCancel(picked)) {
		cancel('Scaffold cancelled.')
		return undefined
	}

	if (picked === custom) {
		const entered = await text({
			message: 'Template (name or path)',
			placeholder: known.includes('plugin') ? 'plugin' : known[0]!,
			validate: (value) => (String(value).trim() ? undefined : 'required'),
		})
		if (isCancel(entered)) {
			cancel('Scaffold cancelled.')
			return undefined
		}
		return String(entered).trim()
	}

	return String(picked).trim()
}

export function resolveTemplateBase(
	input: string,
	options: { cwd?: string; templatesDir?: string } = {},
) {
	const cwd = options.cwd ?? process.cwd()
	const templatesDir = options.templatesDir ?? resolveTemplatesDir()
	if (isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) {
		return input
	}
	// Allow relative paths like ./templates/foo in addition to named templates.
	if (input.startsWith('.') || input.includes('/') || input.includes('\\')) {
		return resolve(cwd, input)
	}
	return resolve(templatesDir, input)
}

export async function generateFromTemplate(
	params: {
		templateBase: string
		targetDir: string
		data: Record<string, string>
		force: boolean
		dryRun: boolean
		fs?: typeof fs
	},
	log: (...args: unknown[]) => void,
): Promise<boolean> {
	const fileSystem = params.fs ?? fs
	let force = params.force
	if (!fileSystem.existsSync(params.templateBase)) {
		const available = listKnownTemplates(fileSystem)
		const hint = available.length > 0 ? `\nAvailable templates: ${available.join(', ')}` : ''
		throw new Error(`Template not found: ${params.templateBase}${hint}`)
	}

	const templateFiles = await listTemplateFiles(params.templateBase, fileSystem)
	const userDocs = await loadUserDocsConfig(params.templateBase, fileSystem)
	if (templateFiles.length === 0) {
		throw new Error(`No template files found in ${params.templateBase}`)
	}

	const outputs: TemplateOutput[] = templateFiles.map((templatePath) => {
		const relPath = relative(params.templateBase, templatePath)
		const renderedRelPath = renderTemplateValue(relPath, params.data, `template path (${relPath})`)
		const isTextTemplate = templatePath.endsWith(TEMPLATE_EXT)
		const outputRelPath = isTextTemplate ? stripTemplateExt(renderedRelPath) : renderedRelPath
		const outputPath = resolve(params.targetDir, outputRelPath)
		return { templatePath, outputPath, outputRelPath, isTextTemplate }
	})

	if (userDocs) {
		const sourceDir = resolveUserDocsDir(fileSystem)
		if (!fileSystem.existsSync(sourceDir)) {
			throw new Error(`Pluxel user docs not found: ${sourceDir}`)
		}
		const discoveredFiles = await walkTemplateFiles(sourceDir, fileSystem)
		const files = userDocs.files ?? discoveredFiles.map((path) => relative(sourceDir, path))
		if (files.length === 0) throw new Error(`Pluxel user docs directory is empty: ${sourceDir}`)
		for (const file of files) {
			const sourcePath = resolveContainedPath(sourceDir, file, 'user docs source')
			if (!fileSystem.existsSync(sourcePath)) {
				throw new Error(`Pluxel user doc not found: ${sourcePath}`)
			}
			const outputRelPath = relative(
				params.targetDir,
				resolveContainedPath(params.targetDir, `${userDocs.target}/${file}`, 'user docs target'),
			)
			outputs.push({
				templatePath: sourcePath,
				outputPath: resolve(params.targetDir, outputRelPath),
				outputRelPath,
				isTextTemplate: false,
			})
		}
	}

	const duplicates = new Map<string, string>()
	for (const output of outputs) {
		if (duplicates.has(output.outputPath)) {
			const prev = duplicates.get(output.outputPath)!
			throw new Error(`Template output collision:\n- ${prev}\n- ${output.templatePath}`)
		}
		duplicates.set(output.outputPath, output.templatePath)
	}

	const existing = outputs.filter((output) => fileSystem.existsSync(output.outputPath))
	const existingSet = new Set(existing.map((output) => output.outputPath))
	const existingDirs = existing.filter((output) => {
		try {
			return fileSystem.statSync(output.outputPath).isDirectory()
		} catch {
			return false
		}
	})
	if (existingDirs.length > 0) {
		const list = existingDirs.map((output) => output.outputRelPath).join('\n')
		throw new Error(`Target contains directories at file paths:\n${list}`)
	}

	if (params.dryRun) {
		log(`\n→ Files to be generated (${outputs.length})`)
		for (const output of outputs) {
			const exists = existingSet.has(output.outputPath)
			const tag = exists ? (force ? 'overwrite' : 'exists') : 'create'
			log(`  - [${tag}] ${output.outputRelPath}`)
		}
		if (!force && existing.length > 0) {
			log(`\n→ Note: ${existing.length} existing files detected (run will require --force).`)
		}
		return true
	}

	if (!force && existing.length > 0) {
		if (isInteractive()) {
			const previewMax = 12
			const list = existing
				.slice(0, previewMax)
				.map((output) => `- ${output.outputRelPath}`)
				.join('\n')
			const more =
				existing.length > previewMax ? `\n… and ${existing.length - previewMax} more` : ''

			const ok = await confirm({
				message: `Target has ${existing.length} existing file(s). Overwrite?${list ? `\n${list}` : ''}${more}`,
				initialValue: false,
			})
			if (isCancel(ok)) {
				cancel('Scaffold cancelled.')
				return false
			}
			if (!ok) {
				cancel('No changes made.')
				return false
			}
			force = true
		} else {
			const list = existing.map((output) => output.outputRelPath).join('\n')
			throw new Error(`Target contains existing files:\n${list}\nUse --force to overwrite.`)
		}
	}

	fileSystem.mkdirSync(params.targetDir, { recursive: true })
	log(`\n→ Generating plugin to ${params.targetDir}`)
	for (const output of outputs) {
		fileSystem.mkdirSync(dirname(output.outputPath), { recursive: true })

		if (output.isTextTemplate) {
			const contents = await fileSystem.promises.readFile(output.templatePath, 'utf8')
			const renderedContents = renderTemplateValue(
				contents,
				params.data,
				`template file (${output.templatePath})`,
			)
			await fileSystem.promises.writeFile(output.outputPath, renderedContents, 'utf8')
		} else {
			await fileSystem.promises.copyFile(output.templatePath, output.outputPath)
		}

		log(existingSet.has(output.outputPath) ? 'overwritten:' : 'created:', output.outputPath)
	}

	return true
}

export async function promptTemplateData(
	templateBase: string,
	baseData: Record<string, string>,
	options: { fs?: typeof fs } = {},
): Promise<Record<string, string> | null> {
	const prompts = await loadTemplatePrompts(templateBase, options.fs ?? fs)
	if (!prompts || prompts.length === 0) return {}

	const reserved = new Set(Object.keys(baseData))
	const answers: Record<string, string> = {}
	const interactive = isInteractive()

	for (const prompt of prompts) {
		const name = assertPromptName(prompt)
		if (reserved.has(name)) {
			throw new Error(`Template prompt "${name}" conflicts with a reserved key`)
		}
		if (name in answers) {
			throw new Error(`Duplicate template prompt name: ${name}`)
		}

		const promptScope = { ...baseData, ...answers }
		const message = renderPromptValue(assertPromptMessage(prompt, name), promptScope, 'message')
		const type = normalizePromptType(prompt.type)
		if (!interactive) {
			answers[name] = resolveNonInteractivePromptDefault(prompt, promptScope, name, type)
			continue
		}

		if (type === 'confirm') {
			const result = await confirm({
				message,
				active: prompt.active,
				inactive: prompt.inactive,
				initialValue: typeof prompt.default === 'boolean' ? prompt.default : undefined,
			})
			if (isCancel(result)) {
				cancel('Scaffold cancelled.')
				return null
			}
			answers[name] = result ? 'true' : 'false'
			continue
		}

		if (type === 'select') {
			const selectOptions = normalizePromptOptions(prompt, name)
			const result = await select({
				message,
				options: selectOptions,
				initialValue:
					typeof prompt.default === 'string'
						? renderPromptValue(prompt.default, promptScope, 'default')
						: undefined,
				maxItems: prompt.maxItems,
			})
			if (isCancel(result)) {
				cancel('Scaffold cancelled.')
				return null
			}
			answers[name] = String(result)
			continue
		}

		const result = await text({
			message,
			placeholder:
				typeof prompt.placeholder === 'string'
					? renderPromptValue(prompt.placeholder, promptScope, 'placeholder')
					: undefined,
			defaultValue:
				typeof prompt.default === 'string'
					? renderPromptValue(prompt.default, promptScope, 'default')
					: undefined,
		})
		if (isCancel(result)) {
			cancel('Scaffold cancelled.')
			return null
		}
		answers[name] = String(result)
	}

	return answers
}

function resolveNonInteractivePromptDefault(
	prompt: TemplatePrompt,
	scope: Record<string, string>,
	name: string,
	type: ReturnType<typeof normalizePromptType>,
): string {
	if (type === 'confirm') {
		if (typeof prompt.default !== 'boolean') {
			throw new TypeError(`Non-interactive prompt "${name}" requires a boolean default`)
		}
		return prompt.default ? 'true' : 'false'
	}

	if (typeof prompt.default !== 'string') {
		throw new TypeError(`Non-interactive prompt "${name}" requires a string default`)
	}
	const value = renderPromptValue(prompt.default, scope, 'default')
	if (type === 'select') {
		const options = normalizePromptOptions(prompt, name)
		if (!options.some((option) => option.value === value)) {
			throw new Error(`Non-interactive prompt "${name}" default is not one of its choices`)
		}
	}
	return value
}

function isInteractive() {
	return Boolean(process.stdout.isTTY && process.stdin.isTTY)
}

function stripTemplateExt(p: string) {
	return p.endsWith(TEMPLATE_EXT) ? p.slice(0, -TEMPLATE_EXT.length) : p
}

function resolveHelper(name: string) {
	switch (name) {
		case 'kebabCase':
			return kebabCase
		case 'pascalCase':
			return pascalCase
		case 'capitalize':
			return capitalize
		case 'json':
			return (value: string) => JSON.stringify(value)
		default:
			return undefined
	}
}

function renderTemplate(input: string, data: Record<string, string>) {
	return input.replace(TEMPLATE_REGEX, (_match, helperName, keyName, plainKey) => {
		const key = String(keyName ?? plainKey)
		const value = data[key]
		if (value === undefined) {
			throw new Error(`Unknown template key: ${key}`)
		}
		if (!helperName) return value
		const helper = resolveHelper(String(helperName))
		if (!helper) {
			throw new Error(`Unknown template helper: ${helperName}`)
		}
		return helper(value)
	})
}

function renderTemplateValue(input: string, data: Record<string, string>, label: string) {
	try {
		return renderTemplate(input, data)
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		throw new Error(`Invalid ${label}: ${reason}`, { cause: error })
	}
}

async function listTemplateFiles(templateBase: string, fileSystem: typeof fs): Promise<string[]> {
	const files = await walkTemplateFiles(templateBase, fileSystem)
	return files.filter((path) => {
		const rel = relative(templateBase, path)
		return !TEMPLATE_CONTROL_FILES.has(rel)
	})
}

type TemplateOutput = {
	templatePath: string
	outputPath: string
	outputRelPath: string
	isTextTemplate: boolean
}

type UserDocsConfig = {
	target: string
	files?: string[]
}

function resolveContainedPath(root: string, path: string, label: string): string {
	if (!path || isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) {
		throw new Error(`Invalid ${label} path: ${path}`)
	}
	const resolved = resolve(root, path)
	const rel = relative(root, resolved)
	if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) {
		throw new Error(`Invalid ${label} path: ${path}`)
	}
	return resolved
}

async function loadUserDocsConfig(
	templateBase: string,
	fileSystem: typeof fs,
): Promise<UserDocsConfig | null> {
	for (const fileName of ['user-docs.jsonc', 'user-docs.json']) {
		const filePath = resolve(templateBase, fileName)
		if (!fileSystem.existsSync(filePath)) continue

		const raw = await fileSystem.promises.readFile(filePath, 'utf8')
		const errors: ParseError[] = []
		const parsed = parse(raw, errors, { allowTrailingComma: true }) as
			| Partial<UserDocsConfig>
			| undefined
		if (errors.length > 0) {
			const detail = printParseErrorCode(errors[0]!.error)
			throw new Error(`Invalid user docs config: ${filePath} (${detail})`)
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			throw new TypeError(`Invalid user docs config: ${filePath} (expected object)`)
		}
		if (typeof parsed.target !== 'string' || !parsed.target.trim()) {
			throw new TypeError(`Invalid user docs config: ${filePath} (target must be a path)`)
		}
		if (
			parsed.files !== undefined &&
			(!Array.isArray(parsed.files) ||
				parsed.files.length === 0 ||
				parsed.files.some((file) => typeof file !== 'string' || !file.trim()))
		) {
			throw new TypeError(`Invalid user docs config: ${filePath} (files must be non-empty paths)`)
		}
		const target = parsed.target.trim()
		resolveContainedPath('template-output', target, 'user docs target')
		const files = parsed.files?.map((file) => file.trim())
		for (const file of files ?? []) resolveContainedPath('user-docs', file, 'user docs source')
		if (files && new Set(files).size !== files.length) {
			throw new TypeError(`Invalid user docs config: ${filePath} (duplicate files)`)
		}
		return { target, files }
	}

	return null
}

type PromptChoice = {
	value?: string
	label?: string
	name?: string
	hint?: string
}

type TemplatePrompt = {
	name: string
	message: string
	type?: string
	default?: string | boolean
	placeholder?: string
	choices?: Array<string | PromptChoice>
	options?: Array<string | PromptChoice>
	active?: string
	inactive?: string
	maxItems?: number
}

function renderPromptValue(value: string, scope: Record<string, string>, label: string): string {
	return renderTemplateValue(value, scope, `prompt ${label}`)
}

async function loadTemplatePrompts(
	templateBase: string,
	fileSystem: typeof fs,
): Promise<TemplatePrompt[] | null> {
	const candidates = ['prompts.jsonc', 'prompts.json']
	for (const fileName of candidates) {
		const filePath = resolve(templateBase, fileName)
		if (!fileSystem.existsSync(filePath)) continue

		const raw = await fileSystem.promises.readFile(filePath, 'utf8')
		const errors: ParseError[] = []
		const parsed = parse(raw, errors, { allowTrailingComma: true })
		if (errors.length > 0) {
			const first = errors[0]!
			const detail = printParseErrorCode(first.error)
			throw new Error(`Invalid prompts config: ${filePath} (${detail})`)
		}
		if (!Array.isArray(parsed)) {
			throw new TypeError(`Invalid prompts config: ${filePath} (expected array)`)
		}
		return parsed as TemplatePrompt[]
	}

	return null
}

function assertPromptName(prompt: TemplatePrompt) {
	if (typeof prompt.name !== 'string' || !prompt.name.trim()) {
		throw new Error('Template prompt requires a non-empty "name"')
	}
	return prompt.name.trim()
}

function assertPromptMessage(prompt: TemplatePrompt, name: string) {
	if (typeof prompt.message !== 'string' || !prompt.message.trim()) {
		throw new Error(`Template prompt "${name}" requires a non-empty "message"`)
	}
	return prompt.message.trim()
}

function normalizePromptType(type: TemplatePrompt['type']) {
	const raw = typeof type === 'string' ? type : 'input'
	switch (raw) {
		case 'input':
		case 'text':
			return 'text'
		case 'confirm':
			return 'confirm'
		case 'list':
		case 'select':
			return 'select'
		default:
			throw new Error(`Unsupported prompt type: ${String(type)}`)
	}
}

function normalizePromptOptions(prompt: TemplatePrompt, name: string) {
	const choices = prompt.choices ?? prompt.options
	if (!Array.isArray(choices) || choices.length === 0) {
		throw new Error(`Template prompt "${name}" requires non-empty choices`)
	}
	return choices.map((choice, index) => {
		if (typeof choice === 'string') {
			return { value: choice, label: choice }
		}
		if (!choice || typeof choice !== 'object') {
			throw new Error(`Invalid choice at index ${index} for prompt "${name}"`)
		}
		const value = typeof choice.value === 'string' ? choice.value : undefined
		const label =
			typeof choice.label === 'string'
				? choice.label
				: typeof choice.name === 'string'
					? choice.name
					: value
		if (!value || !label) {
			throw new Error(`Choice at index ${index} for prompt "${name}" needs value or label`)
		}
		return {
			value,
			label,
			hint: typeof choice.hint === 'string' ? choice.hint : undefined,
		}
	})
}
