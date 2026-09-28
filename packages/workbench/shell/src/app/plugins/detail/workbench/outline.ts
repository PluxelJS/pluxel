export type OutlineAnchor = {
	id: string
	label: string
	depth: number
}

export type OutlineNode = OutlineAnchor & {
	children: OutlineNode[]
}

export function buildOutlineTree(anchors: OutlineAnchor[]): OutlineNode[] {
	const roots: OutlineNode[] = []
	const stack: OutlineNode[] = []

	for (const anchor of anchors) {
		const node: OutlineNode = {
			id: anchor.id,
			label: anchor.label,
			depth: anchor.depth,
			children: [],
		}

		while (stack.length > 0 && stack.at(-1).depth >= node.depth) stack.pop()
		if (stack.length > 0) stack.at(-1).children.push(node)
		else roots.push(node)
		stack.push(node)
	}

	return roots
}

export function filterOutlineTree(
	items: OutlineNode[],
	normalizedQuery: string,
): { items: OutlineNode[]; matchCount: number } {
	if (!normalizedQuery) {
		return {
			items,
			matchCount: countOutlineNodes(items),
		}
	}

	let matchCount = 0
	const matches = (label: string) => label.toLowerCase().includes(normalizedQuery)

	const filterNode = (node: OutlineNode): OutlineNode | null => {
		const nextChildren = node.children
			.map((child) => filterNode(child))
			.filter(Boolean) as OutlineNode[]
		const selfMatch = matches(node.label)

		if (selfMatch) matchCount += 1
		if (selfMatch || nextChildren.length > 0) {
			return { ...node, children: nextChildren }
		}
		return null
	}

	return {
		items: items.map((node) => filterNode(node)).filter(Boolean) as OutlineNode[],
		matchCount,
	}
}

function countOutlineNodes(items: OutlineNode[]): number {
	return items.reduce((total, item) => total + 1 + countOutlineNodes(item.children), 0)
}
