import type { FieldLayoutMeta } from '~/core/actions'
import { DEFAULT_GRID_COLUMNS, GRID_COLUMN_THRESHOLD } from '~/core/constants'

export function resolveSectionColumns(fieldCount: number, explicit?: number, compactCount = 0) {
	if (explicit && explicit > 0) return explicit
	if (fieldCount <= 1) return 1
	if (compactCount >= 2) {
		return Math.min(DEFAULT_GRID_COLUMNS, Math.max(2, Math.min(fieldCount, DEFAULT_GRID_COLUMNS)))
	}
	if (fieldCount >= GRID_COLUMN_THRESHOLD) return DEFAULT_GRID_COLUMNS
	return 1
}

export function resolveFieldSpan(columns: number, layout?: FieldLayoutMeta) {
	if (columns <= 1) return 1
	if (layout?.fullWidth) return columns
	if (layout?.span) return Math.min(columns, Math.max(1, layout.span))
	return 1
}

export function alignToCss(align?: FieldLayoutMeta['align']) {
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
