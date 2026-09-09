import { DEFAULT_SECTION_ID } from '../../../core/constants'
import { extractFormFields, type FieldNode, type NormalizedSectionMeta } from '../../../core/fields'
import type { ObjectLikeSchema } from '../../../core'
import { countCompactFields, resolveSectionColumns } from './layout'

export interface PlannedField {
	name: string
	node: FieldNode
}

export interface SectionPlan {
	id: string
	title?: string
	description?: string
	order?: number
	columns: number
	fields: PlannedField[]
}

export interface FieldPlanResult {
	sections: SectionPlan[]
	hiddenFields: PlannedField[]
}

interface SectionBucket {
	id: string
	fields: PlannedField[]
	title?: string
	description?: string
	order?: number
	explicitColumns?: number
}

function ensureBucket(buckets: Map<string, SectionBucket>, id: string) {
	let bucket = buckets.get(id)
	if (!bucket) {
		bucket = { id, fields: [] }
		buckets.set(id, bucket)
	}
	return bucket
}

function applySectionMeta(bucket: SectionBucket, field: PlannedField) {
	const sectionMeta = field.node.meta.section as NormalizedSectionMeta | undefined
	if (!sectionMeta) return

	if (sectionMeta.title && !bucket.title) bucket.title = sectionMeta.title
	if (sectionMeta.description && !bucket.description) bucket.description = sectionMeta.description
	if (sectionMeta.order !== undefined && bucket.order === undefined)
		bucket.order = sectionMeta.order
	if (sectionMeta.columns && !bucket.explicitColumns) bucket.explicitColumns = sectionMeta.columns
}

function buildSections(fields: PlannedField[]): SectionPlan[] {
	const buckets = new Map<string, SectionBucket>()
	for (const field of fields) {
		const sectionId = field.node.meta.section?.id ?? DEFAULT_SECTION_ID
		const bucket = ensureBucket(buckets, sectionId)
		bucket.fields.push(field)
		applySectionMeta(bucket, field)
	}

	return Array.from(buckets.values())
		.sort((a, b) => {
			const orderA = a.order ?? 0
			const orderB = b.order ?? 0
			if (orderA !== orderB) return orderA - orderB
			return (a.title ?? '').localeCompare(b.title ?? '')
		})
		.map((bucket) => ({
			id: bucket.id,
			title: bucket.title,
			description: bucket.description,
			order: bucket.order,
			columns: resolveSectionColumns(
				bucket.fields.length,
				bucket.explicitColumns,
				countCompactFields(bucket.fields.map((f) => f.node)),
			),
			fields: bucket.fields,
		}))
}

export function planFieldSections(fields: FieldNode[]): FieldPlanResult {
	const hiddenFields: PlannedField[] = []
	const visibleFields: PlannedField[] = []
	for (const node of fields) {
		if (node.name === undefined) continue
		const planned: PlannedField = { name: node.name, node }
		if (node.meta.hidden) hiddenFields.push(planned)
		else visibleFields.push(planned)
	}

	return {
		sections: buildSections(visibleFields),
		hiddenFields,
	}
}

export function planSchemaFields(schema: ObjectLikeSchema): FieldPlanResult {
	return planFieldSections(extractFormFields(schema as any))
}
