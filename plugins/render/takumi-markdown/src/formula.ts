import { MarkdownError } from './errors.ts'

const ALLOWED_FORMULA = /^[\p{L}\p{N}\p{Sm}\p{Sk}\s()[\]{}.,_!|+\-*/^=<>]+$/u
const FORBIDDEN_IDENTIFIER =
	/(?:^|[^\p{L}\p{N}_])(import|include|read|sys|image|raw|eval|plugin)(?:$|[^\p{L}\p{N}_])/iu

/** Restricted math expressions; document execution and resource syntax are rejected before IO. */
export function validateTypstMathFormula(value: unknown, maxCharacters: number): string {
	if (typeof value !== 'string' || !value.trim()) {
		throw new MarkdownError('FORMULA_INVALID', 'Typst math formula must be a non-empty string')
	}
	if (value.length > maxCharacters) {
		throw new MarkdownError(
			'FORMULA_TOO_LARGE',
			'Typst math formula exceeds the configured character limit',
		)
	}
	if (!ALLOWED_FORMULA.test(value) || FORBIDDEN_IDENTIFIER.test(value)) {
		throw new MarkdownError(
			'FORMULA_INVALID',
			'Typst math formula uses syntax outside the restricted math dialect',
		)
	}
	return value
}

export function createTypstMathSource(
	formula: string,
	options: Readonly<{ display: boolean; foreground: string }>,
): string {
	const delimiter = options.display ? ' ' : ''
	return (
		'#set page(width: auto, height: auto, margin: 0pt, fill: none)\n' +
		`#set text(size: 12pt, fill: rgb("${options.foreground}"), top-edge: "bounds", bottom-edge: "bounds")\n` +
		'$' +
		delimiter +
		formula.trim() +
		delimiter +
		'$'
	)
}
