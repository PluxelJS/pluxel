// array/type.ts
export type ArrayMetaOptions<T extends string | number = string | number> = {
	addable?: boolean
	removeLabel?: string
	addLabel?: string
	removable?: boolean
	reorderable?: boolean
	layout?: 'list' | 'grid' | 'table'
	/** @deprecated 请使用 layout */
	style?: 'list' | 'grid' | 'table'
	pickerMode?: 'list' | 'picker'
	columns?: number
	itemLabel?: string
	defaultItem?: unknown
	valueMode?: 'auto' | 'string' | 'number' | 'boolean' | 'json' | 'picklist' | 'defaults-picker'
	emptyHint?: string
	minItems?: number
	maxItems?: number
	/** 当 valueMode === 'picklist' 时启用 MultiSelect（默认一切合理默认）；defaults-picker 模式下 options 可选 */
	picklist?: {
		/** picklist 模式必填，defaults-picker 模式可选（选项来自 defaultValues） */
		options?: readonly T[]
		entries?: readonly {
			value: T
			label?: string
			description?: string
			group?: string
			disabled?: boolean
			accentColor?: string
		}[]
		labels?: Partial<Record<T, string>>
		disabled?: readonly T[]
		placeholder?: string
		searchable?: boolean
		clearable?: boolean
		maxValues?: number
		variant?: 'select' | 'segmented' | 'radio'
		allowCreate?: boolean
		nothingFoundLabel?: string
	}
}

/** 提炼结果：可带出子项元数据（由回调决定） */
export type ArrayMetaResult<TItemMeta = unknown> = ArrayMetaOptions & {
	item?: TItemMeta
}
