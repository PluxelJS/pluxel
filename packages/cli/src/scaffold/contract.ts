import fs from 'node:fs'
import { resolve } from 'pathe'
import { type ParseError, parse, printParseErrorCode } from 'jsonc-parser'
import type { PM } from '../utils/pm'
import { scaffoldError } from './errors'
import { isTemplateVariableName } from './render'

export const TEMPLATE_MANIFEST = 'pluxel-template.jsonc'

export type TemplatePrompt =
	| {
			name: string
			type: 'text'
			message: string
			default?: string
			placeholder?: string
	  }
	| {
			name: string
			type: 'confirm'
			message: string
			default?: boolean
			active?: string
			inactive?: string
	  }
	| {
			name: string
			type: 'select'
			message: string
			default?: string
			choices: readonly { value: string; label: string; hint?: string }[]
	  }

export type TemplateContract = {
	schemaVersion: 1
	id: string
	packageManager?: { name: PM }
	prompts: readonly TemplatePrompt[]
}

const ROOT_FIELDS = new Set(['schemaVersion', 'id', 'packageManager', 'prompts'])
const PACKAGE_MANAGER_FIELDS = new Set(['name'])
const PROMPT_COMMON_FIELDS = new Set(['name', 'type', 'message', 'default'])
const TEXT_PROMPT_FIELDS = new Set([...PROMPT_COMMON_FIELDS, 'placeholder'])
const CONFIRM_PROMPT_FIELDS = new Set([...PROMPT_COMMON_FIELDS, 'active', 'inactive'])
const SELECT_PROMPT_FIELDS = new Set([...PROMPT_COMMON_FIELDS, 'choices'])
const CHOICE_FIELDS = new Set(['value', 'label', 'hint'])
const PACKAGE_MANAGERS = new Set<PM>(['pnpm', 'npm', 'yarn', 'bun'])

export async function loadTemplateContract(
	templateRoot: string,
	options: { fs?: typeof fs } = {},
): Promise<TemplateContract> {
	const fileSystem = options.fs ?? fs
	const manifestPath = resolve(templateRoot, TEMPLATE_MANIFEST)
	if (!fileSystem.existsSync(manifestPath)) {
		throw scaffoldError(
			'TEMPLATE_CONTRACT_INVALID',
			`Template is missing ${TEMPLATE_MANIFEST}: ${templateRoot}`,
		)
	}

	let raw: string
	try {
		raw = await fileSystem.promises.readFile(manifestPath, 'utf8')
	} catch (error) {
		throw scaffoldError('TEMPLATE_CONTRACT_INVALID', `Cannot read ${manifestPath}`, error)
	}
	const errors: ParseError[] = []
	const parsed = parse(raw, errors, { allowTrailingComma: true }) as unknown
	if (errors.length > 0) {
		throw scaffoldError(
			'TEMPLATE_CONTRACT_INVALID',
			`Invalid ${TEMPLATE_MANIFEST}: ${printParseErrorCode(errors[0]!.error)}`,
		)
	}
	return validateTemplateContract(parsed, manifestPath)
}

export function validateTemplateContract(
	input: unknown,
	label = TEMPLATE_MANIFEST,
): TemplateContract {
	const value = expectRecord(input, label)
	assertKnownFields(value, ROOT_FIELDS, label)
	if (value.schemaVersion !== 1) {
		throw scaffoldError(
			'TEMPLATE_SCHEMA_UNSUPPORTED',
			`Unsupported template schemaVersion in ${label}: ${String(value.schemaVersion)}`,
		)
	}
	const id = expectIdentifier(value.id, `${label}.id`)

	let packageManager: TemplateContract['packageManager']
	if (value.packageManager !== undefined) {
		const policy = expectRecord(value.packageManager, `${label}.packageManager`)
		assertKnownFields(policy, PACKAGE_MANAGER_FIELDS, `${label}.packageManager`)
		if (typeof policy.name !== 'string' || !PACKAGE_MANAGERS.has(policy.name as PM)) {
			invalid(`${label}.packageManager.name must be a supported package manager`)
		}
		packageManager = { name: policy.name as PM }
	}

	const rawPrompts = value.prompts ?? []
	if (!Array.isArray(rawPrompts)) invalid(`${label}.prompts must be an array`)
	const promptNames = new Set<string>()
	const prompts = rawPrompts.map((prompt, index) => {
		const normalized = validatePrompt(prompt, `${label}.prompts[${index}]`)
		if (promptNames.has(normalized.name)) {
			invalid(`${label} contains duplicate prompt name: ${normalized.name}`)
		}
		promptNames.add(normalized.name)
		return normalized
	})

	return {
		schemaVersion: 1,
		id,
		...(packageManager ? { packageManager } : {}),
		prompts,
	}
}

function validatePrompt(input: unknown, label: string): TemplatePrompt {
	const value = expectRecord(input, label)
	const name = expectTemplateVariable(value.name, `${label}.name`)
	const message = expectString(value.message, `${label}.message`)
	const type = value.type ?? 'text'

	if (type === 'text') {
		assertKnownFields(value, TEXT_PROMPT_FIELDS, label)
		return {
			name,
			type,
			message,
			...(value.default === undefined
				? {}
				: { default: expectString(value.default, `${label}.default`) }),
			...(value.placeholder === undefined
				? {}
				: { placeholder: expectString(value.placeholder, `${label}.placeholder`) }),
		}
	}
	if (type === 'confirm') {
		assertKnownFields(value, CONFIRM_PROMPT_FIELDS, label)
		if (value.default !== undefined && typeof value.default !== 'boolean') {
			invalid(`${label}.default must be a boolean`)
		}
		return {
			name,
			type,
			message,
			...(value.default === undefined ? {} : { default: value.default as boolean }),
			...(value.active === undefined
				? {}
				: { active: expectString(value.active, `${label}.active`) }),
			...(value.inactive === undefined
				? {}
				: { inactive: expectString(value.inactive, `${label}.inactive`) }),
		}
	}
	if (type === 'select') {
		assertKnownFields(value, SELECT_PROMPT_FIELDS, label)
		if (!Array.isArray(value.choices) || value.choices.length === 0) {
			invalid(`${label}.choices must be a non-empty array`)
		}
		const choices = value.choices.map((choice, index) => {
			const normalized = expectRecord(choice, `${label}.choices[${index}]`)
			assertKnownFields(normalized, CHOICE_FIELDS, `${label}.choices[${index}]`)
			return {
				value: expectString(normalized.value, `${label}.choices[${index}].value`),
				label: expectString(normalized.label, `${label}.choices[${index}].label`),
				...(normalized.hint === undefined
					? {}
					: { hint: expectString(normalized.hint, `${label}.choices[${index}].hint`) }),
			}
		})
		const choiceValues = new Set(choices.map((choice) => choice.value))
		if (choiceValues.size !== choices.length) invalid(`${label}.choices contain duplicate values`)
		const defaultValue =
			value.default === undefined ? undefined : expectString(value.default, `${label}.default`)
		if (defaultValue !== undefined && !choiceValues.has(defaultValue)) {
			invalid(`${label}.default must match one of its choices`)
		}
		return {
			name,
			type,
			message,
			choices,
			...(defaultValue === undefined ? {} : { default: defaultValue }),
		}
	}

	invalid(`${label}.type must be "text", "confirm", or "select"`)
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		invalid(`${label} must be an object`)
	return value as Record<string, unknown>
}

function expectString(value: unknown, label: string): string {
	if (typeof value !== 'string' || !value.trim()) invalid(`${label} must be a non-empty string`)
	return value.trim()
}

function expectIdentifier(value: unknown, label: string): string {
	const text = expectString(value, label)
	if (!/^[a-z][a-z0-9-]*$/.test(text)) invalid(`${label} must be a kebab-case identifier`)
	return text
}

function expectTemplateVariable(value: unknown, label: string): string {
	const text = expectString(value, label)
	if (!isTemplateVariableName(text)) {
		invalid(`${label} must be a template variable identifier`)
	}
	return text
}

function assertKnownFields(
	value: Record<string, unknown>,
	known: ReadonlySet<string>,
	label: string,
) {
	const unknown = Object.keys(value).filter((key) => !known.has(key))
	if (unknown.length > 0) invalid(`${label} contains unknown field: ${unknown[0]}`)
}

function invalid(message: string): never {
	throw scaffoldError('TEMPLATE_CONTRACT_INVALID', message)
}
