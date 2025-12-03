import type { FieldLayoutMeta } from '~/core/actions'
import { DEFAULT_GRID_COLUMNS, GRID_COLUMN_THRESHOLD } from '~/core/constants'

/**
 * 布局工具函数
 *
 * 布局策略：
 * 1. 复杂类型（object/array/union/record）始终占满整行
 * 2. 紧凑字段数量达到阈值（GRID_COLUMN_THRESHOLD）时才启用多列布局
 * 3. 可通过 layout.fullWidth 或 layout.span 手动控制
 */

/** 复杂类型集合（需要占满整行的字段类型） */
const COMPLEX_TYPES = new Set(['object', 'array', 'union', 'record'])

/** 判断是否为复杂类型 */
export function isComplexType(type: string): boolean {
	return COMPLEX_TYPES.has(type)
}

/** 计算紧凑字段数量（排除复杂类型） */
export function countCompactFields(fields: Array<{ type: string }>): number {
	return fields.filter(f => !isComplexType(f.type)).length
}

/**
 * 计算 Section 的列数
 * @param fieldCount 字段总数
 * @param explicit 显式指定的列数（优先级最高）
 * @param compactCount 紧凑字段数量
 */
export function resolveSectionColumns(fieldCount: number, explicit?: number, compactCount = 0): number {
	// 显式指定优先
	if (explicit && explicit > 0) return explicit
	// 单字段无需多列
	if (fieldCount <= 1) return 1
	// 紧凑字段数量达到阈值时启用多列
	if (compactCount >= GRID_COLUMN_THRESHOLD) {
		return Math.min(DEFAULT_GRID_COLUMNS, Math.max(2, Math.min(fieldCount, DEFAULT_GRID_COLUMNS)))
	}
	// 总字段数达到阈值时启用多列（兼容旧逻辑）
	if (fieldCount >= GRID_COLUMN_THRESHOLD) return DEFAULT_GRID_COLUMNS
	return 1
}

/**
 * 计算字段的 grid span
 * @param columns 当前布局的列数
 * @param layout 字段的布局配置
 * @param fieldType 字段类型（用于判断复杂类型）
 */
export function resolveFieldSpan(columns: number, layout?: FieldLayoutMeta, fieldType?: string): number {
	if (columns <= 1) return 1
	// 复杂类型始终占满整行
	if (fieldType && isComplexType(fieldType)) return columns
	// 显式全宽
	if (layout?.fullWidth) return columns
	// 显式 span
	if (layout?.span) return Math.min(columns, Math.max(1, layout.span))
	return 1
}

/** 将 align 配置转换为 CSS alignSelf 值 */
export function alignToCss(align?: FieldLayoutMeta['align']): string {
	switch (align) {
		case 'center':
			return 'center'
		case 'end':
			return 'flex-end'
		case 'stretch':
			return 'stretch'
		default:
			return 'flex-start'
	}
}
