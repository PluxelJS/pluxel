import fs from 'node:fs'
import { cancel, confirm, isCancel, select, text } from '@clack/prompts'
import { fdir } from 'fdir'
import { dirname, isAbsolute, relative, resolve } from 'pathe'
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser'
import { capitalize, kebabCase, pascalCase } from './name'
import { resolveTemplatesDir } from './utils'

const TEMPLATE_PROMPT_FILES = new Set(['prompts.json', 'prompts.jsonc'])
const TEMPLATE_EXT = '.hbs'

const TEMPLATE_REGEX = /{{\s*([a-zA-Z][\w]*)\s+([a-zA-Z0-9_]+)\s*}}|{{\s*([a-zA-Z0-9_]+)\s*}}/g

export async function ensureTemplate(explicit?: string): Promise<string | undefined> {
	const normalized = typeof explicit === 'string' ? explicit.trim() : ''
	if (normalized) return normalized

	const known = listKnownTemplates()
	if (known.length === 0) {
		throw new Error(`No templates found under ${resolveTemplatesDir()}`)
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

export function resolveTemplateBase(input: string) {
	if (isAbsolute(input) || /^[A-Za-z]:[\\/]/.test(input)) {
		return input
	}
	// Allow relative paths like ./templates/foo in addition to named templates.
	if (input.startsWith('.') || input.includes('/') || input.includes('\\')) {
		return resolve(process.cwd(), input)
	}
	return resolveTemplatesDir(input)
}

export async function generateFromTemplate(
	params: {
		templateBase: string
		targetDir: string
		data: Record<string, string>
		force: boolean
		dryRun: boolean
	},
	log: (...args: unknown[]) => void,
): Promise<boolean> {
	let force = params.force
	if (!fs.existsSync(params.templateBase)) {
		const available = listKnownTemplates()
		const hint = available.length > 0 ? `\nAvailable templates: ${available.join(', ')}` : ''
		throw new Error(`Template not found: ${params.templateBase}${hint}`)
	}

	const templateFiles = await listTemplateFiles(params.templateBase)
	if (templateFiles.length === 0) {
		throw new Error(`No template files found in ${params.templateBase}`)
	}

	const outputs = templateFiles.map((templatePath) => {
		const relPath = relative(params.templateBase, templatePath)
		const renderedRelPath = renderTemplateValue(relPath, params.data, `template path (${relPath})`)
		const isTextTemplate = templatePath.endsWith(TEMPLATE_EXT)
		const outputRelPath = isTextTemplate ? stripTemplateExt(renderedRelPath) : renderedRelPath
		const outputPath = resolve(params.targetDir, outputRelPath)
		return { templatePath, outputPath, outputRelPath, isTextTemplate }
	})

	const duplicates = new Map<string, string>()
	for (const output of outputs) {
		if (duplicates.has(output.outputPath)) {
			const prev = duplicates.get(output.outputPath)!
			throw new Error(`Template output collision:\n- ${prev}\n- ${output.templatePath}`)
		}
		duplicates.set(output.outputPath, output.templatePath)
	}

	const existing = outputs.filter((output) => fs.existsSync(output.outputPath))
	const existingSet = new Set(existing.map((output) => output.outputPath))
	const existingDirs = existing.filter((output) => {
		try {
			return fs.statSync(output.outputPath).isDirectory()
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

	fs.mkdirSync(params.targetDir, { recursive: true })
	log(`\n→ Generating plugin to ${params.targetDir}`)
	for (const output of outputs) {
		fs.mkdirSync(dirname(output.outputPath), { recursive: true })

		if (output.isTextTemplate) {
			const contents = await fs.promises.readFile(output.templatePath, 'utf8')
			const renderedContents = renderTemplateValue(
				contents,
				params.data,
				`template file (${output.templatePath})`,
			)
			await fs.promises.writeFile(output.outputPath, renderedContents, 'utf8')
		} else {
			await fs.promises.copyFile(output.templatePath, output.outputPath)
		}

		log(existingSet.has(output.outputPath) ? 'overwritten:' : 'created:', output.outputPath)
	}

	return true
}

export async function promptTemplateData(
	templateBase: string,
	baseData: Record<string, string>,
): Promise<Record<string, string> | null> {
	const prompts = await loadTemplatePrompts(templateBase)
	if (!prompts || prompts.length === 0) return {}

	const reserved = new Set(Object.keys(baseData))
	const answers: Record<string, string> = {}

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
			const options = normalizePromptOptions(prompt, name)
			const result = await select({
				message,
				options,
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
		throw new Error(`Invalid ${label}: ${reason}`)
	}
}

async function listTemplateFiles(templateBase: string): Promise<string[]> {
	const files = await new fdir()
		.withFullPaths()
		.filter((_path, isDir) => !isDir)
		.crawl(templateBase)
		.withPromise()

	return files
		.filter((path) => {
			const rel = relative(templateBase, path)
			return !TEMPLATE_PROMPT_FILES.has(rel)
		})
		.sort((a, b) => a.localeCompare(b))
}

function listKnownTemplates(): string[] {
	const base = resolveTemplatesDir()
	if (!fs.existsSync(base)) return []
	try {
		return fs
			.readdirSync(base, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
			.map((entry) => entry.name)
			.sort((a, b) => a.localeCompare(b))
	} catch {
		return []
	}
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

async function loadTemplatePrompts(templateBase: string): Promise<TemplatePrompt[] | null> {
	const candidates = ['prompts.jsonc', 'prompts.json']
	for (const fileName of candidates) {
		const filePath = resolve(templateBase, fileName)
		if (!fs.existsSync(filePath)) continue

		const raw = await fs.promises.readFile(filePath, 'utf8')
		const errors: ParseError[] = []
		const parsed = parse(raw, errors)
		if (errors.length > 0) {
			const first = errors[0]!
			const detail = printParseErrorCode(first.error)
			throw new Error(`Invalid prompts config: ${filePath} (${detail})`)
		}
		if (!Array.isArray(parsed)) {
			throw new Error(`Invalid prompts config: ${filePath} (expected array)`)
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
