/** Native TextAlign values supported by both strict admission and Typst output. */
export const textAlignments = ['left', 'center', 'right', 'justify'] as const

export function validTextAlignment(value: unknown): boolean {
	return value === null || textAlignments.some((alignment) => alignment === value)
}

/** Admit original CSS before the browser or official extension can discard it. */
export function textAlignmentDeclarationError(style: string): string | undefined {
	const declarations = style
		.split(';')
		.map((part) => part.trim())
		.filter(Boolean)
	if (
		declarations.length > 1 ||
		declarations.some(
			(declaration) => !/^text-align\s*:\s*(?:left|center|right|justify)$/.test(declaration),
		)
	)
		return 'Paragraph and heading styles support one text-align declaration: left, center, right or justify.'
	return undefined
}
