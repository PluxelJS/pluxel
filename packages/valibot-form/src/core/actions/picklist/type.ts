// picklist/type.ts
export type PicklistMetaOptions<T extends string | number = string> = {
	options?: readonly T[]
	labels?: Partial<Record<T, string>>
	placeholder?: string
	/** 若未提供，将走“聪明默认” */
	searchable?: true
	clearable?: true
}
