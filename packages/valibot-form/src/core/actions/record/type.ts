// record/type.ts
export type RecordMetaOptions = {
	addable?: boolean
	removable?: boolean
	reorderable?: boolean
	editableKey?: boolean
	layout?: 'list' | 'table'
	/** @deprecated 使用 layout = 'table' */
	asTable?: boolean
	columns?: { key?: number | string; value?: number | string }
	keyLabel?: string
	valueLabel?: string
	keyPlaceholder?: string
	valuePlaceholder?: string
	emptyHint?: string
	/** string|number|boolean|json|auto */
	valueMode?: 'auto' | 'string' | 'number' | 'boolean' | 'json'
	minItems?: number
	maxItems?: number
}

export type RecordMetaResult<TKeyMeta = unknown, TValueMeta = unknown> = RecordMetaOptions & {
	key?: TKeyMeta
	value?: TValueMeta
}
