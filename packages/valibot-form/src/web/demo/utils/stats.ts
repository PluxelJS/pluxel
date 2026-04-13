import type { ObjectSchema } from 'valibot'
import { extractFormFields } from '../../../core/fields'

const COMPLEX_KINDS = new Set(['object', 'array', 'union', 'record'])

export interface CaseStats {
	fieldCount: number
	complexCount: number
	sectionCount: number
}

export function buildCaseStats(schema: ObjectSchema<any, any>): CaseStats {
	const fields = extractFormFields(schema as any)
	const fieldCount = fields.length
	const complexCount = fields.filter((field) => COMPLEX_KINDS.has(field.kind)).length
	const sectionIds = new Set(
		fields
			.map((field) => field.meta.section?.id)
			.filter(Boolean) as string[],
	)
	return {
		fieldCount,
		complexCount,
		sectionCount: sectionIds.size > 0 ? sectionIds.size : fieldCount ? 1 : 0,
	}
}
