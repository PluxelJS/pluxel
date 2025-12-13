export function mergeNamespaces(...lists: Array<string[] | undefined>): string[] {
	return Array.from(
		new Set(
			lists
				.flatMap((list) => list ?? [])
				.map((ns) => ns.trim())
				.filter(Boolean),
		),
	)
}

