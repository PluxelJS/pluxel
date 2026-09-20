export function toDomSlug(value: string) {
	return (
		value
			.toLowerCase()
			.replaceAll(/[^a-z0-9_-]+/gi, '-')
			.replaceAll(/^-+|-+$/g, '') || 'section'
	)
}

export function findScrollableParent(node: HTMLElement | null): HTMLElement | null {
	let current: HTMLElement | null = node
	while (current && current !== document.body) {
		const style = getComputedStyle(current)
		const overflowY = style.overflowY
		if (overflowY === 'auto' || overflowY === 'scroll') {
			return current
		}
		current = current.parentElement
	}
	return document.scrollingElement as HTMLElement | null
}

export function makeSectionAnchorPrefix(pluginName: string, tabKey: string) {
	return `config-${toDomSlug(pluginName)}-${toDomSlug(tabKey)}-section-`
}

export function makeFieldAnchorPrefix(pluginName: string, tabKey: string) {
	return `config-${toDomSlug(pluginName)}-${toDomSlug(tabKey)}-field-`
}
