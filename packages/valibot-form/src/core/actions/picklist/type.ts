// picklist/type.ts
export type PicklistVariant = 'select' | 'segmented' | 'radio'

export interface PicklistEntry<T extends string | number = string> {
	value: T
	label?: string
	description?: string
	group?: string
	disabled?: boolean
	accentColor?: string
}

export type PicklistMetaOptions<T extends string | number = string> = {
	options?: readonly T[]
	entries?: readonly PicklistEntry<T>[]
	labels?: Partial<Record<T, string>>
	placeholder?: string
	searchable?: boolean
	clearable?: boolean
	multiple?: boolean
	variant?: PicklistVariant
	disabled?: readonly T[]
	maxSelections?: number
	allowCreate?: boolean
	nothingFoundLabel?: string
}
