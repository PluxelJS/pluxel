import { readProductDescriptor, type ProductDescriptor } from './product-contract'

export function readHostProduct(
	moduleNamespace: Record<string, unknown>,
	label: string,
): ProductDescriptor | null {
	if (!Object.hasOwn(moduleNamespace, 'product')) return null

	let value: unknown
	try {
		value = moduleNamespace.product
	} catch (cause) {
		throw new TypeError(`${label} named export "product" could not be read`, { cause })
	}
	if (hasThenMethod(value)) {
		throw new TypeError(`${label} named export "product" must not be a Promise`)
	}
	return readProductDescriptor(value, `${label} named export "product"`)
}

function hasThenMethod(value: unknown): boolean {
	if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return false

	let current: object | null = value
	while (current) {
		const descriptor = Object.getOwnPropertyDescriptor(current, 'then')
		if (descriptor) return 'value' in descriptor && typeof descriptor.value === 'function'
		current = Object.getPrototypeOf(current)
	}
	return false
}

export function sameProduct(
	left: ProductDescriptor | null,
	right: ProductDescriptor | null,
): boolean {
	if (left === right) return true
	if (left === null || right === null) return false
	if (
		left.displayName !== right.displayName ||
		left.publisher !== right.publisher ||
		left.copyright !== right.copyright
	) {
		return false
	}
	const leftLinks = left.legalLinks ?? []
	const rightLinks = right.legalLinks ?? []
	return (
		leftLinks.length === rightLinks.length &&
		leftLinks.every(
			(link, index) =>
				link.label === rightLinks[index]?.label && link.href === rightLinks[index]?.href,
		)
	)
}
