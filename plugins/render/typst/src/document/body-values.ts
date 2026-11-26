import { fontFamilyName, textStyleColor } from '../tiptap/text-style.js'

/** Literal project-relative paths, optionally rooted in the compiler workspace. */
export function bodyImagePath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length <= 1024 &&
		value
			.replace(/^\//, '')
			.split('/')
			.every(
				(part) =>
					part !== '.' &&
					part !== '..' &&
					/^[\p{L}\p{M}\p{N}._ -]+$/u.test(part) &&
					part === part.trim(),
			)
	)
}

export function bodyLink(value: unknown): value is string {
	if (
		typeof value !== 'string' ||
		value.length > 2048 ||
		!value.isWellFormed() ||
		/[\s\\]/u.test(value) ||
		[...value].some((character) => asciiControl(character.codePointAt(0)!))
	)
		return false
	try {
		const url = new URL(value)
		if (url.protocol === 'http:' || url.protocol === 'https:')
			return /^https?:\/\/[^/]/iu.test(value)
		return url.protocol === 'mailto:' || url.protocol === 'tel:'
	} catch {
		return false
	}
}

export function bodyLanguage(value: unknown): value is string {
	return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9+_-]{0,63}$/.test(value)
}

export function positiveNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value) && value > 0
}

export function bodyNumber(value: number): string {
	return String(value).replace('e+', 'e')
}

/** Canonicalize the pixel value that will be recovered from an emitted pt literal. */
export function bodyPixels(value: number): number {
	return (value * 0.75) / 0.75
}

/** One relative width broadcasts over a grid so uniform tables survive column edits. */
export function relativeColumnWidths(widths: string[] | undefined): string[] | null {
	if (!widths?.some((width) => width !== 'auto')) return null
	return widths.every((width) => width === widths[0]) ? [widths[0]!] : widths
}

export function bodyColor(value: unknown): string | undefined {
	const color = textStyleColor(value)
	if (!color) return
	const { red, green, blue, alpha } = color
	const channels = alpha === 1 ? [red, green, blue] : [red, green, blue, Math.round(alpha * 255)]
	return '#' + channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')
}

export function bodyFont(value: unknown): string | undefined {
	const name = fontFamilyName(value)
	if (!name) return
	return fontFamilyName(name) ? name : '"' + name + '"'
}

const asciiControl = (point: number) => point < 0x20 || point === 0x7f

export function bodyString(value: string): string {
	let result = '"'
	for (const character of value) {
		const point = character.codePointAt(0)!
		if (character === '"' || character === '\\') result += '\\' + character
		else if (character === '\n') result += '\\n'
		else if (character === '\r') result += '\\r'
		else if (character === '\t') result += '\\t'
		else if (asciiControl(point)) result += `\\u{${point.toString(16)}}`
		else result += character
	}
	return result + '"'
}

export function bodyText(value: string): string {
	let result = ''
	const characters = [...value]
	for (const [index, character] of characters.entries()) {
		const point = character.codePointAt(0)!
		// Multiple forms of whitespace collapse in markup, and punctuation can join
		// adjacent text into markup tokens. Literal escapes keep token boundaries fixed.
		if (
			(character === ' ' &&
				(index === 0 ||
					index === characters.length - 1 ||
					characters[index - 1] === ' ' ||
					characters[index + 1] === ' ')) ||
			(character !== ' ' && /\s/u.test(character)) ||
			/[\\#*_\x60@$<>[\]{}()="'~;+\-/.]/u.test(character) ||
			asciiControl(point)
		)
			result += `\\u{${point.toString(16)}}`
		else result += character
	}
	return result
}
