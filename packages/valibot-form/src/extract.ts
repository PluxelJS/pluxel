import type { OptionalSchema } from 'valibot'
import type { FormMeta } from './actions'
import {
	type ExtractMap,
	MetaType,
	type Schema,
	extractMap,
	getFormMeta,
} from './utils'
export type FormInfo = FormMeta & { required: boolean }
export function extractInfo(schema: Schema, defaults: FormMeta) {
	const formMeta = getFormMeta(schema, MetaType.FORM) ?? defaults

	const formInfo: FormInfo = { ...formMeta, required: true }

	if (schema.type === 'optional') {
		const optionalSchema = schema as OptionalSchema<any, any>
		formInfo.required = false
		schema = optionalSchema.wrapped
	}

	if (schema.type in extractMap === false) return undefined
	const schemaType = schema.type as keyof ExtractMap
	const { extract, type } = extractMap[schemaType]

	const props = extract(schema as any) as ReturnType<
		ExtractMap[keyof ExtractMap]['extract']
	>
	return { props, formInfo, type }
}
