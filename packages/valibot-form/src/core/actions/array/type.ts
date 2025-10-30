// array/type.ts
export type ArrayMetaOptions<T extends string | number = string | number> = {
	addable?: true
	removable?: true
	reorderable?: true
	style?: 'list' | 'grid' | 'table'
	columns?: number
	itemLabel?: string
	defaultItem?: unknown
	valueMode?: 'auto' | 'string' | 'number' | 'boolean' | 'json' | 'picklist'
	/** 当 valueMode === 'picklist' 时启用 MultiSelect（默认一切合理默认） */
	picklist?: {
		options: readonly T[]
		labels?: Partial<Record<T, string>>
		disabled?: readonly T[]
		placeholder?: string
		searchable?: true // 覆盖智能默认
		clearable?: true // 覆盖智能默认
		maxValues?: number // 覆盖智能默认
		limit?: number // 覆盖智能默认
	}
}

/** 提炼结果：可带出子项元数据（由回调决定） */
export type ArrayMetaResult<TItemMeta = unknown> = ArrayMetaOptions & {
	item?: TItemMeta
}
