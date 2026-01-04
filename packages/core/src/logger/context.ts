export type PluxelContextLike = {
	name: string
	pluginInfo?: { id?: string } | undefined
	parent?: unknown
	caller?: unknown
}

export function findPluginId(ctx: PluxelContextLike): string | undefined {
	let current: PluxelContextLike | undefined = ctx
	while (current) {
		const id = current.pluginInfo?.id
		if (id) return id
		current = (current.parent as any) ?? (current.caller as any)
	}
	return undefined
}

