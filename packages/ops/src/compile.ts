import { deepFreeze } from './internal/freeze'
import { toJsonSchema } from './schema'
import { OpError, type OpDescriptor, type OperationConfig } from './types'

const OP_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/
const MAX_TITLE_LENGTH = 120
const MAX_DESCRIPTION_LENGTH = 500

const normalizeText = (value: string | undefined) => {
	const text = value?.trim()
	return text ? text : undefined
}

const throwConfigError = (message: string) => {
	throw new OpError('E_OP_CONFIG', 'Invalid operation config', { message })
}

const requireSingleLine = (label: string, value: string) => {
	if (value.includes('\n')) throwConfigError(`${label} must be a single line`)
}

const requireMaxLength = (label: string, value: string, maxLength: number) => {
	if (value.length > maxLength) throwConfigError(`${label} must be at most ${maxLength} characters`)
}

const validateOpId = (id: string) => {
	if (!OP_ID_PATTERN.test(id)) {
		throwConfigError(
			`Operation id "${id}" must match ${String(OP_ID_PATTERN)} (lowercase letters, numbers, dot, dash, underscore)`,
		)
	}
}

const normalizeDoc = (config: OperationConfig<any, any, any>) => {
	const title = normalizeText(config.doc?.title)
	const description = normalizeText(config.doc?.description)
	if (!title) throwConfigError(`Operation "${config.id}" must define doc.title`)
	if (!description) throwConfigError(`Operation "${config.id}" must define doc.description`)
	requireSingleLine(`doc.title for "${config.id}"`, title)
	requireSingleLine(`doc.description for "${config.id}"`, description)
	requireMaxLength(`doc.title for "${config.id}"`, title, MAX_TITLE_LENGTH)
	requireMaxLength(`doc.description for "${config.id}"`, description, MAX_DESCRIPTION_LENGTH)
	return { title, description }
}

export const compileDescriptor = (config: OperationConfig<any, any, any>): OpDescriptor => {
	validateOpId(config.id)
	const descriptor: OpDescriptor = {
		id: config.id,
		doc: normalizeDoc(config),
		schemas: {
			input: toJsonSchema(config.input),
			output: toJsonSchema(config.output),
		},
	}
	return deepFreeze(descriptor)
}
