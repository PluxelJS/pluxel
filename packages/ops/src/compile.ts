import { deepFreeze } from './internal/freeze'
import type { OpRuntime } from './internal/runtime'
import { deriveParamSpecs, toJsonSchema } from './schema'
import {
	OpError,
	type CliTailConfig,
	type CliTailSpec,
	type OpDescriptor,
	type OpDoc,
	type OpExposure,
	type OperationConfig,
} from './types'

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const OP_ID_PATTERN = TOOL_NAME_PATTERN
const CLI_TRIGGER_TOKEN_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]*$/
const MAX_TOOL_NAME_LENGTH = 96
const MAX_TITLE_LENGTH = 80
const MAX_DESCRIPTION_LENGTH = 240
const MAX_USAGE_LENGTH = 240
const MAX_DETAILS_LENGTH = 4000
const MAX_EXAMPLES = 5
const MAX_TAGS = 8

const normalizeExposure = (exposure: OpExposure | undefined): Required<OpExposure> => ({
	rpc: exposure?.rpc === true,
	internal: exposure?.internal === true,
})

const deriveCliUsage = (
	id: string,
	params: OpDescriptor['params'],
	cli: Exclude<OperationConfig<any, any, any>['cli'], false | true | undefined> | undefined,
) => {
	const trigger = cli?.triggers?.[0] ? cli.triggers[0] : id
	const out = [trigger]
	for (const param of params ?? []) {
		const placeholder =
			param.type === 'boolean'
				? `--${param.name}`
				: `--${param.name} <${param.type === 'json' ? 'json' : param.type}>`
		out.push(param.required ? placeholder : `[${placeholder}]`)
	}
	if (cli?.tail) out.push(cli.tail.placeholder ?? (cli.tail.mode === 'json' ? '<json>' : '<text>'))
	return out.join(' ')
}

const toDescriptorTail = (tail: CliTailConfig | undefined): CliTailSpec | undefined => {
	if (!tail) return undefined
	if (tail.mode !== 'parsebox') return tail
	return {
		mode: 'parsebox',
		entry: String(tail.entry),
		...(tail.placeholder ? { placeholder: tail.placeholder } : {}),
		...(tail.keys ? { keys: [...tail.keys] } : {}),
	}
}

export const compileRuntime = (config: OperationConfig<any, any, any>): OpRuntime => {
	const cliConfig = config.cli && config.cli !== true ? config.cli : undefined
	const tail = cliConfig?.tail
	if (!tail || tail.mode !== 'parsebox') return Object.freeze({})
	return Object.freeze({
		cli: Object.freeze({
			parseboxTail: Object.freeze({
				mode: 'parsebox',
				module: tail.module,
				entry: tail.entry,
				...(tail.placeholder ? { placeholder: tail.placeholder } : {}),
				...(tail.keys ? { keys: Object.freeze([...tail.keys]) } : {}),
			}),
		}),
	})
}

const normalizeText = (value: string | undefined) => {
	const text = value?.trim()
	return text ? text : undefined
}

const normalizeTextList = (value: string[] | undefined) => {
	if (!Array.isArray(value) || value.length === 0) return undefined
	const out = Array.from(new Set(value.map((entry) => entry.trim()).filter(Boolean)))
	return out.length > 0 ? out : undefined
}

const normalizeDoc = (doc: OpDoc | undefined): OpDoc => {
	const title = normalizeText(doc?.title)
	const description = normalizeText(doc?.description)
	const details = normalizeText(doc?.details)
	const usage = normalizeText(doc?.usage)
	const examples = normalizeTextList(doc?.examples)
	const tags = normalizeTextList(doc?.tags)

	return {
		...(title ? { title } : {}),
		...(description ? { description } : {}),
		...(details ? { details } : {}),
		...(usage ? { usage } : {}),
		...(examples ? { examples } : {}),
		...(tags ? { tags } : {}),
	}
}

const throwConfigError = (message: string) => {
	throw new OpError('E_OP_CONFIG', 'Invalid operation config', { message })
}

const requireSingleLine = (label: string, value: string | undefined) => {
	if (!value) return
	if (value.includes('\n')) throwConfigError(`${label} must be a single line`)
}

const requireMaxLength = (label: string, value: string | undefined, maxLength: number) => {
	if (!value) return
	if (value.length > maxLength) throwConfigError(`${label} must be at most ${maxLength} characters`)
}

const validateDocForTool = (doc: OpDoc, id: string) => {
	if (!doc.title) throwConfigError(`Tool-visible op "${id}" must define doc.title`)
	if (!doc.description) throwConfigError(`Tool-visible op "${id}" must define doc.description`)
	requireSingleLine(`doc.title for "${id}"`, doc.title)
	requireSingleLine(`doc.description for "${id}"`, doc.description)
	requireSingleLine(`doc.usage for "${id}"`, doc.usage)
	requireMaxLength(`doc.title for "${id}"`, doc.title, MAX_TITLE_LENGTH)
	requireMaxLength(`doc.description for "${id}"`, doc.description, MAX_DESCRIPTION_LENGTH)
	requireMaxLength(`doc.usage for "${id}"`, doc.usage, MAX_USAGE_LENGTH)
	requireMaxLength(`doc.details for "${id}"`, doc.details, MAX_DETAILS_LENGTH)

	if (doc.examples && doc.examples.length > MAX_EXAMPLES) {
		throwConfigError(`doc.examples for "${id}" must contain at most ${MAX_EXAMPLES} items`)
	}
	for (const example of doc.examples ?? []) requireSingleLine(`doc.examples for "${id}"`, example)

	if (doc.tags && doc.tags.length > MAX_TAGS) {
		throwConfigError(`doc.tags for "${id}" must contain at most ${MAX_TAGS} items`)
	}
	for (const tag of doc.tags ?? []) {
		if (!TAG_PATTERN.test(tag)) {
			throwConfigError(`doc.tags for "${id}" must use lowercase kebab-case tokens`)
		}
	}
}

const validateToolName = (id: string, name: string) => {
	if (name.length > MAX_TOOL_NAME_LENGTH) {
		throwConfigError(`tool.name for "${id}" must be at most ${MAX_TOOL_NAME_LENGTH} characters`)
	}
	if (!TOOL_NAME_PATTERN.test(name)) {
		throwConfigError(
			`tool.name for "${id}" must match ${String(TOOL_NAME_PATTERN)} (lowercase letters, numbers, dot, dash, underscore)`,
		)
	}
}

const validateOpId = (id: string) => {
	if (!OP_ID_PATTERN.test(id)) {
		throwConfigError(
			`Operation id "${id}" must match ${String(OP_ID_PATTERN)} (lowercase letters, numbers, dot, dash, underscore)`,
		)
	}
}

const validateCliTriggers = (id: string, triggers: readonly string[]) => {
	for (const trigger of triggers) {
		const tokens = trigger.trim().split(/\s+/g).filter(Boolean)
		if (tokens.length === 0) throwConfigError(`CLI trigger for "${id}" must not be empty`)
		for (const token of tokens) {
			if (!CLI_TRIGGER_TOKEN_PATTERN.test(token)) {
				throwConfigError(`CLI trigger "${trigger}" for "${id}" must use lowercase word tokens`)
			}
		}
	}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === 'object' && !Array.isArray(value)

const validateInputDescriptionsForTool = (
	id: string,
	schema: Record<string, unknown>,
	path: string[] = [],
) => {
	for (const variant of [schema.anyOf, schema.oneOf, schema.allOf]) {
		if (!Array.isArray(variant)) continue
		for (const entry of variant) {
			if (isRecord(entry)) validateInputDescriptionsForTool(id, entry, path)
		}
	}

	if (schema.type === 'array' && isRecord(schema.items)) {
		validateInputDescriptionsForTool(id, schema.items, [...path, '[]'])
		return
	}

	if (schema.type !== 'object' || !isRecord(schema.properties)) return

	for (const [key, value] of Object.entries(schema.properties)) {
		if (!isRecord(value)) continue
		const fieldPath = [...path, key]
		if (typeof value.description !== 'string' || !value.description.trim()) {
			throwConfigError(
				`Tool-visible op "${id}" must describe input "${fieldPath.join('.')}" in the input schema`,
			)
		}
		validateInputDescriptionsForTool(id, value, fieldPath)
	}
}

const buildToolGuidance = (doc: OpDoc, params: OpDescriptor['params']) => {
	const parts = [doc.description ?? doc.title ?? '']
	if (doc.details) parts.push(doc.details)
	if (doc.usage) parts.push(`Usage: ${doc.usage}`)
	if (doc.examples?.length) {
		const lines = ['Examples:']
		for (const example of doc.examples) lines.push(`- ${example}`)
		parts.push(lines.join('\n'))
	}
	const describedParams = (params ?? []).filter((param) => param.description)
	if (describedParams.length > 0) {
		const lines = ['Inputs:']
		for (const param of describedParams) {
			lines.push(
				`- ${param.inputKey} (${param.type}${param.required ? ', required' : ', optional'}): ${param.description}`,
			)
		}
		parts.push(lines.join('\n'))
	}
	return parts.filter(Boolean).join('\n\n')
}

export const compileDescriptor = (config: OperationConfig<any, any, any>): OpDescriptor => {
	validateOpId(config.id)
	const exposure = normalizeExposure(config.exposure)
	if (exposure.internal && (exposure.rpc || Boolean(config.cli) || Boolean(config.tool))) {
		throwConfigError(`Internal op "${config.id}" cannot declare rpc, cli, or tool exposure`)
	}
	const doc = normalizeDoc(config.doc)
	const inputSchema = toJsonSchema(config.input)
	const outputSchema = toJsonSchema(config.output)
	const params = deriveParamSpecs(config.input)

	const descriptor: OpDescriptor = {
		id: config.id,
		doc,
		exposure,
		policy: { ...config.policy },
		schemas: {
			input: inputSchema,
			output: outputSchema,
		},
		transports: {},
		...(params ? { params } : {}),
	}

	if (config.cli) {
		const cliConfig = config.cli === true ? undefined : config.cli
		const triggers = normalizeTextList(cliConfig?.triggers) ?? [config.id]
		validateCliTriggers(config.id, triggers)
		descriptor.transports.cli = {
			triggers,
			...(cliConfig?.tail ? { tail: toDescriptorTail(cliConfig.tail) } : {}),
			usage: doc.usage || deriveCliUsage(config.id, params, cliConfig),
		}
	}

	if (config.tool) {
		const toolConfig = config.tool === true ? undefined : config.tool
		const name = toolConfig?.name?.trim() || config.id
		validateToolName(config.id, name)
		validateDocForTool(doc, config.id)
		validateInputDescriptionsForTool(config.id, descriptor.schemas.input)
		const inputHints =
			params && params.length > 0
				? params.map((param) => ({
						key: param.inputKey,
						type: param.type,
						required: param.required,
						...(param.description ? { description: param.description } : {}),
					}))
				: undefined
		descriptor.transports.tool = {
			id: config.id,
			name,
			title: doc.title || name,
			description: doc.description || doc.title || name,
			guidance: buildToolGuidance(doc, params),
			...(doc.details ? { details: doc.details } : {}),
			...(doc.usage ? { usage: doc.usage } : {}),
			...(doc.examples ? { examples: [...doc.examples] } : {}),
			...(doc.tags ? { tags: [...doc.tags] } : {}),
			...(inputHints ? { inputHints } : {}),
			inputSchema: descriptor.schemas.input,
			outputSchema: descriptor.schemas.output,
		}
	}

	return deepFreeze(descriptor)
}
