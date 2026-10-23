/** The portable subset shared by raw JSON, clipboard admission and Typst output. */
export const textStyleAttributes = ['fontFamily', 'fontSize', 'color', 'backgroundColor'] as const
export type TextStyleAttribute = (typeof textStyleAttributes)[number]

/** A quoted CSS family is still one name; lists, escapes and CSS-wide keywords are not. */
export function fontFamilyName(value: unknown): string | undefined {
	if (typeof value !== 'string') return undefined
	const quoted = value.startsWith('"') || value.startsWith("'")
	if (quoted && (value.length < 3 || value.at(-1) !== value[0])) return undefined
	const name = quoted ? value.slice(1, -1) : value
	if (
		name !== name.trim() ||
		!/^[\p{L}\p{N}][\p{L}\p{M}\p{N} -]*$/u.test(name) ||
		(!quoted && name.split(' ').some((word) => !/^\p{L}/u.test(word))) ||
		/^(?:inherit|initial|unset|revert|revert-layer)$/i.test(name)
	)
		return undefined
	return name
}

export function fontSizeInPoints(value: unknown): number | undefined {
	if (typeof value !== 'string') return undefined
	const match = /^(\d+(?:\.\d+)?|\.\d+)(pt|px)$/.exec(value)
	if (!match) return undefined
	const points = Number(match[1]) * (match[2] === 'px' ? 0.75 : 1)
	return Number.isFinite(points) && points > 0 ? points : undefined
}

export interface TextStyleColor {
	red: number
	green: number
	blue: number
	alpha: number
}

/** Hex and the numeric RGB(A) form emitted by browser CSSOM; never evaluate CSS. */
export function textStyleColor(value: unknown): TextStyleColor | undefined {
	if (typeof value !== 'string') return undefined
	if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) {
		const hex =
			value.length <= 5 ? value.slice(1).replaceAll(/./g, (digit) => digit + digit) : value.slice(1)
		return {
			red: Number.parseInt(hex.slice(0, 2), 16),
			green: Number.parseInt(hex.slice(2, 4), 16),
			blue: Number.parseInt(hex.slice(4, 6), 16),
			alpha: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
		}
	}
	const match =
		/^(rgb|rgba)\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(0(?:\.\d+)?|1(?:\.0+)?|\.\d+))?\s*\)$/i.exec(
			value,
		)
	if (!match || (match[1]!.toLowerCase() === 'rgba') !== (match[5] !== undefined)) return undefined
	const [red, green, blue] = match.slice(2, 5).map(Number) as [number, number, number]
	if ([red, green, blue].some((channel) => channel > 255)) return undefined
	return { red, green, blue, alpha: match[5] === undefined ? 1 : Number(match[5]) }
}

export function validTextStyleValue(attribute: TextStyleAttribute, value: unknown): boolean {
	if (value === null) return true
	if (attribute === 'fontFamily') return fontFamilyName(value) !== undefined
	if (attribute === 'fontSize') return fontSizeInPoints(value) !== undefined
	return textStyleColor(value) !== undefined
}

const cssAttributes: Record<string, TextStyleAttribute> = {
	'font-family': 'fontFamily',
	'font-size': 'fontSize',
	color: 'color',
	'background-color': 'backgroundColor',
}

/** Inspect the raw declaration text before CSSOM can silently discard invalid values. */
export function textStyleDeclarationError(style: string): string | undefined {
	const properties = new Set<string>()
	for (const declaration of style.split(';')) {
		if (!declaration.trim()) continue
		const colon = declaration.indexOf(':')
		if (colon === -1) return 'Expected a CSS property and value.'
		const property = declaration.slice(0, colon).trim().toLowerCase()
		const attribute = Object.hasOwn(cssAttributes, property) ? cssAttributes[property] : undefined
		if (!attribute) return `Unsupported inline text style: ${property}.`
		if (properties.has(property)) return `Duplicate inline text style: ${property}.`
		properties.add(property)
		if (!validTextStyleValue(attribute, declaration.slice(colon + 1).trim()))
			return `Invalid portable ${property} value.`
	}
	return undefined
}
