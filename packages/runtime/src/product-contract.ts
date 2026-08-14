export type ProductLegalLink = Readonly<{
	label: string
	href: string
}>

export type ProductDescriptor = Readonly<{
	displayName: string
	publisher?: string
	copyright?: string
	legalLinks?: readonly ProductLegalLink[]
}>

export type HostApplicationMeta = Readonly<{
	product: ProductDescriptor | null
}>

const PRODUCT_FIELDS = new Set(['displayName', 'publisher', 'copyright', 'legalLinks'])
const LEGAL_LINK_FIELDS = new Set(['label', 'href'])

export function readProductDescriptor(value: unknown, label: string): ProductDescriptor {
	const product = readPlainRecord(value, label)
	assertKnownFields(product, PRODUCT_FIELDS, label)

	const displayName = readText(product, 'displayName', label, 1, 80)
	const publisher = readOptionalText(product, 'publisher', label, 1, 120)
	const copyright = readOptionalText(product, 'copyright', label, 1, 300)
	const legalLinks = readLegalLinks(product.legalLinks, label)

	return Object.freeze({
		displayName,
		...(publisher === undefined ? {} : { publisher }),
		...(copyright === undefined ? {} : { copyright }),
		...(legalLinks === undefined ? {} : { legalLinks }),
	})
}

function readLegalLinks(value: unknown, label: string): readonly ProductLegalLink[] | undefined {
	if (value === undefined) return undefined
	if (!Array.isArray(value)) throw new TypeError(`${label}.legalLinks must be an array`)
	if (value.length > 8) throw new TypeError(`${label}.legalLinks must contain at most 8 links`)

	return Object.freeze(
		value.map((entry, index) => {
			const entryLabel = `${label}.legalLinks[${index}]`
			const link = readPlainRecord(entry, entryLabel)
			assertKnownFields(link, LEGAL_LINK_FIELDS, entryLabel)
			return Object.freeze({
				label: readText(link, 'label', entryLabel, 1, 60),
				href: readLegalHref(link.href, `${entryLabel}.href`),
			})
		}),
	)
}

function readLegalHref(value: unknown, label: string): string {
	if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
	assertText(value, label, 1, 2_048)
	if (value.includes('\\')) throw new TypeError(`${label} must not contain backslashes`)

	if (value.startsWith('/')) {
		if (value.startsWith('//')) {
			throw new TypeError(`${label} must not be a protocol-relative URL`)
		}
		const parsed = new URL(value, 'https://pluxel.invalid')
		if (parsed.origin !== 'https://pluxel.invalid') {
			throw new TypeError(`${label} must be root-relative`)
		}
		return value
	}

	let parsed: URL
	try {
		parsed = new URL(value)
	} catch {
		throw new TypeError(`${label} must be an http:, https:, or root-relative URL`)
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new TypeError(`${label} must use http: or https:`)
	}
	if (parsed.username || parsed.password) {
		throw new TypeError(`${label} must not contain URL credentials`)
	}
	return value
}

function readOptionalText(
	record: Record<string, unknown>,
	field: string,
	label: string,
	min: number,
	max: number,
): string | undefined {
	if (record[field] === undefined) return undefined
	return readText(record, field, label, min, max)
}

function readText(
	record: Record<string, unknown>,
	field: string,
	label: string,
	min: number,
	max: number,
): string {
	const value = record[field]
	if (typeof value !== 'string') throw new TypeError(`${label}.${field} must be a string`)
	assertText(value, `${label}.${field}`, min, max)
	return value
}

function assertText(value: string, label: string, min: number, max: number): void {
	if (value.trim() !== value) throw new TypeError(`${label} must not have surrounding whitespace`)
	if (hasControlCharacters(value))
		throw new TypeError(`${label} must not contain control characters`)
	const length = [...value].length
	if (length < min || length > max) {
		throw new TypeError(`${label} length must be between ${min} and ${max} Unicode code points`)
	}
}

function hasControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
	}
	return false
}

function readPlainRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`)
	}
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError(`${label} must be a plain object`)
	}
	const descriptors = Object.getOwnPropertyDescriptors(value)
	for (const [field, descriptor] of Object.entries(descriptors)) {
		if (!('value' in descriptor)) throw new TypeError(`${label}.${field} must be a data property`)
	}
	if (Object.getOwnPropertySymbols(value).length > 0) {
		throw new TypeError(`${label} must not contain symbol fields`)
	}
	return value as Record<string, unknown>
}

function assertKnownFields(
	record: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	label: string,
): void {
	const unknown = Object.getOwnPropertyNames(record).filter((field) => !allowed.has(field))
	if (unknown.length === 0) return
	throw new TypeError(
		`${label} includes unsupported ${unknown.map((field) => `"${field}"`).join(', ')}`,
	)
}
