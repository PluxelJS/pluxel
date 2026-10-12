export function toDomSlug(value: string) {
	return (
		value
			.toLowerCase()
			.replaceAll(/[^a-z0-9_-]+/gi, '-')
			.replaceAll(/^-+|-+$/g, '') || 'section'
	)
}

export function makeSectionAnchorPrefix(pluginName: string, tabKey: string) {
	return `config-${toDomSlug(pluginName)}-${toDomSlug(tabKey)}-section-`
}

export function makeFieldAnchorPrefix(pluginName: string, tabKey: string) {
	return `config-${toDomSlug(pluginName)}-${toDomSlug(tabKey)}-field-`
}
