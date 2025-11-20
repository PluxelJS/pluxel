import { DEFAULT_SECTION_ID } from '~/core/constants'
import { collectObjectEntries, META_MAP } from '~/core/utils'
import type { ObjectLikeSchema } from './formContext'
import { cachedExtractInfo } from './schemaCache'
import { resolveSectionColumns } from './layout'

export interface PlannedField {
	name: string
	info: NonNullable<ReturnType<typeof cachedExtractInfo>>
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
	compactCount: number
}

function ensureBucket(buckets: Map<string, SectionBucket>, id: string) {
	let bucket = buckets.get(id)
	if (!bucket) {
		bucket = { id, fields: [], compactCount: 0 }
		buckets.set(id, bucket)
	}
	return bucket
}

function isCompactField(field: PlannedField) {
	const layout = field.info.formInfo.layout
	if (layout?.fullWidth) return false
	if ((layout?.span ?? 1) > 1) return false
	switch (field.info.type) {
		case META_MAP.BOOLEAN:
		case META_MAP.PICKLIST:
			return true
		case META_MAP.STRING: {
			const mode = (field.info.props as any)?.mode
			return mode !== 'textarea' && mode !== 'code'
		}
		case META_MAP.NUMBER: {
			const variant = (field.info.props as any)?.variant
			return variant !== 'slider'
		}
		default:
			return false
	}
}

function applySectionMeta(bucket: SectionBucket, field: PlannedField) {
	const sectionMeta = field.info.formInfo.section
	if (!sectionMeta) return

	if (sectionMeta.title && !bucket.title) bucket.title = sectionMeta.title
	if (sectionMeta.description && !bucket.description) bucket.description = sectionMeta.description
	if (sectionMeta.order !== undefined && bucket.order === undefined) bucket.order = sectionMeta.order
	if (sectionMeta.columns && !bucket.explicitColumns) bucket.explicitColumns = sectionMeta.columns
}

function buildSections(fields: PlannedField[]): SectionPlan[] {
	const buckets = new Map<string, SectionBucket>()
	for (const field of fields) {
		const sectionId = field.info.formInfo.section?.id ?? DEFAULT_SECTION_ID
		const bucket = ensureBucket(buckets, sectionId)
		bucket.fields.push(field)
		if (isCompactField(field)) bucket.compactCount += 1
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
				columns: resolveSectionColumns(bucket.fields.length, bucket.explicitColumns, bucket.compactCount),
				fields: bucket.fields,
			}))
}

export function planSchemaFields(schema: ObjectLikeSchema): FieldPlanResult {
	const entries = collectObjectEntries(schema as any) ?? []
	const hiddenFields: PlannedField[] = []
	const visibleFields: PlannedField[] = []

	for (const entry of entries) {
		const subSchema = entry.schema
		if (subSchema?.kind !== 'schema') continue
		const info = cachedExtractInfo(subSchema, entry.name)
		if (!info) continue
		const planned: PlannedField = { name: entry.name, info }
		if (info.formInfo.hidden) hiddenFields.push(planned)
		else visibleFields.push(planned)
	}

	return {
		sections: buildSections(visibleFields),
		hiddenFields,
	}
}
