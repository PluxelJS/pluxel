import type { OptionalSchema } from 'valibot'
import type { FieldSectionMeta, FormMeta } from './actions'
import { DEFAULT_TEXTS } from './constants'
import {
	type ExtractMap,
	type ExtractableType,
	extractMap,
	getFormMeta,
	isExtractableType,
	META_MAP,
	type Schema,
	collectObjectEntries,
} from './utils'

/**
 * 字段基础信息（提取后的最终表单信息）
 * 所有字段在前端渲染时都有明确的 label，required 状态
 */
export interface FormBaseInfo extends Omit<FormMeta, 'section'> {
	/** 字段标签（必需） */
	label: string
	/** 分组信息（已规范化） */
	section?: FieldSectionMeta
	/** 是否必填 */
	required: boolean
}

export type ExtractedProps<T extends keyof ExtractMap> = ReturnType<ExtractMap[T]['extract']>
type ExtractSchemaArg<T extends keyof ExtractMap> = Parameters<ExtractMap[T]['extract']>[0]

function resolveExtractTarget(schema: Schema):
	| { schema: Schema; type: ExtractableType }
	| undefined {
	if (isExtractableType(schema.type)) {
		return { schema, type: schema.type }
	}

	if (schema.type === 'intersect') {
		const entries = collectObjectEntries(schema)
		if (entries?.length) {
			return { schema, type: META_MAP.object }
		}
	}

	return undefined
}

function normalizeSection(section?: FormMeta['section']): FieldSectionMeta | undefined {
	if (!section) return undefined
	if (typeof section === 'string') {
		return {
			id: section,
			title: section,
		}
	}
	const id = section.id ?? section.title ?? section.description ?? 'section'
	return {
		...section,
		id,
	}
}

/**
 * 将字段名转换为友好的 label
 * @example
 * fieldNameToLabel('userName') => 'User Name'
 * fieldNameToLabel('email') => 'Email'
 * fieldNameToLabel('user_name') => 'User Name'
 * fieldNameToLabel('UserName') => 'User Name'
 */
function fieldNameToLabel(fieldName: string): string {
	// 处理 snake_case
	if (fieldName.includes('_')) {
		return fieldName
			.split('_')
			.map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
			.join(' ')
	}

	// 处理 camelCase 和 PascalCase
	const result = fieldName
		.replace(/([A-Z])/g, ' $1') // 在大写字母前插入空格
		.replace(/^./, str => str.toUpperCase()) // 首字母大写
		.trim()

	return result
}

export function extractInfo(schema: Schema, defaults: FormMeta, fieldName?: string) {
	const metaFromSchema = getFormMeta(schema, META_MAP.FORM)
	const mergedMeta: FormMeta = {
		...defaults,
		...(metaFromSchema ?? {}),
	}

	const section = normalizeSection(mergedMeta.section)
	const { section: _omitSection, ...rest } = mergedMeta

	// 智能 label 推断：
	// 1. 优先使用显式指定的 label
	// 2. 如果没有 label，使用字段名生成友好的 label
	// 3. 如果连字段名都没有，使用默认值
	const label = rest.label || (fieldName ? fieldNameToLabel(fieldName) : '未命名字段')

	const formInfo: FormBaseInfo = {
		...rest,
		label,
		...(section !== undefined && { section }),
		required: true,
	}

	if (schema.type === 'optional') {
		const optionalSchema = schema as OptionalSchema<any, any>
		formInfo.required = false
		schema = optionalSchema.wrapped
	}

	const normalized = resolveExtractTarget(schema)
	if (!normalized) {
		// 在开发环境下提供有用的警告信息
		if (process.env.NODE_ENV !== 'production') {
			console.warn(DEFAULT_TEXTS.errors.extractionFailed(schema.type))
			console.warn('Schema:', schema)
		}
		return undefined
	}
	const { schema: targetSchema, type } = normalized
	const { extract } = extractMap[type]

	const props = extract(targetSchema as ExtractSchemaArg<typeof type>) as ExtractedProps<typeof type>
	return { props, formInfo, type }
}
