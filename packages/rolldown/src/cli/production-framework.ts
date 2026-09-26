export function frameworkFacadeFile(specifier: string): string {
	return `framework/${specifier.replace('@', '').replaceAll('/', '-')}.mjs`
}
