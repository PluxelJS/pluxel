export const pluxelReservedLogPropertyKeys = ['pluginId', 'context', 'name', 'caller'] as const

export const pluxelReservedLogPropertyKeySet: ReadonlySet<string> = new Set(
	pluxelReservedLogPropertyKeys as readonly string[],
)
