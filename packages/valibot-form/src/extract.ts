import type { OptionalSchema } from 'valibot'
import type { FormMeta } from './actions'
import {
	type ExtractMap,
	META_MAP,
	type Schema,
	extractMap,
	getFormMeta,
} from './utils'
export type FormBaseInfo = FormMeta & { required: boolean }
export type ExtractedProps<T extends keyof ExtractMap> = ReturnType<
	ExtractMap[T]['extract']
>
export function extractInfo(schema: Schema, defaults: FormMeta) {
	const formMeta = getFormMeta(schema, META_MAP.FORM) ?? defaults

	const formInfo: FormBaseInfo = { ...formMeta, required: true }

	if (schema.type === 'optional') {
		const optionalSchema = schema as OptionalSchema<any, any>
		formInfo.required = false
		schema = optionalSchema.wrapped
	}

	if (schema.type in extractMap === false) return undefined
	const schemaType = schema.type as keyof ExtractMap
	const { extract, type } = extractMap[schemaType]

	const props = extract(schema as any) as ExtractedProps<any>
	return { props, formInfo, type }
}
