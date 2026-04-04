export type Density = 'comfortable' | 'compact' | 'ultra'

export type RowDensity = {
	rowH: number
	px: number
	py: number
	font: 'xs' | 'sm'
}

export const DENSITY: Record<Density, RowDensity> = {
	comfortable: { rowH: 38, px: 10, py: 8, font: 'sm' },
	compact: { rowH: 30, px: 8, py: 4, font: 'xs' },
	ultra: { rowH: 22, px: 6, py: 1, font: 'xs' },
}

export const FILTERED_FLAT_VIRTUALIZE_THRESHOLD = 300
export const FLAT_VIRTUAL_OVERSCAN = 12

export const UNGROUPED_SCROLL_MAX_HEIGHT = 'clamp(160px, 32vh, 360px)'
