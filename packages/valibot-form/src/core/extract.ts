import type { OptionalSchema } from 'valibot'
import type { FormMeta } from './actions'
import {
	type ExtractMap,
	extractMap,
	getFormMeta,
	isExtractableType,
	META_MAP,
	type Schema,
} from './utils'
export type FormBaseInfo = FormMeta & { required: boolean }
export type ExtractedProps<T extends keyof ExtractMap> = ReturnType<ExtractMap[T]['extract']>
type ExtractSchemaArg<T extends keyof ExtractMap> = Parameters<ExtractMap[T]['extract']>[0]
export function extractInfo(schema: Schema, defaults: FormMeta) {
	const formMeta = getFormMeta(schema, META_MAP.FORM) ?? defaults

	const formInfo: FormBaseInfo = { ...formMeta, required: true }

	if (schema.type === 'optional') {
		const optionalSchema = schema as OptionalSchema<any, any>
		formInfo.required = false
		schema = optionalSchema.wrapped
	}

	if (!isExtractableType(schema.type)) return undefined
	const schemaType = schema.type
	const { extract, type } = extractMap[schemaType]

	const props = extract(schema as ExtractSchemaArg<typeof schemaType>) as ExtractedProps<typeof schemaType>
	return { props, formInfo, type }
}
