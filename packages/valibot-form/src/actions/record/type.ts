// record/type.ts
export type RecordMetaOptions = {
	addable?: true
	removable?: true
	reorderable?: true
	editableKey?: boolean
	asTable?: true
	columns?: { key?: number | string; value?: number | string }
	keyPlaceholder?: string
	valuePlaceholder?: string
	emptyHint?: string
	/** string|number|boolean|json|auto */
	valueMode?: 'auto' | 'string' | 'number' | 'boolean' | 'json'
}

export type RecordMetaResult<
	TKeyMeta = unknown,
	TValueMeta = unknown,
> = RecordMetaOptions & {
	key?: TKeyMeta
	value?: TValueMeta
}
