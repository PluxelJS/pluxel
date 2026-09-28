import { describe, expect, it, vi } from 'vitest'

import { defineProduct } from '@pluxel/services/management/product'

describe('@pluxel/services/management/product', () => {
	it('validates, copies, and deeply freezes browser-safe product metadata', () => {
		const input = {
			displayName: 'Rhythm',
			publisher: 'Example Company',
			copyright: '© 2026 Example Company',
			legalLinks: [{ label: '软件许可', href: '/legal/license' }],
		}
		const product = defineProduct(input)

		expect(product).toEqual(input)
		expect(product).not.toBe(input)
		expect(product.legalLinks).not.toBe(input.legalLinks)
		expect(product.legalLinks?.[0]).not.toBe(input.legalLinks[0])
		expect(Object.isFrozen(product)).toBe(true)
		expect(Object.isFrozen(product.legalLinks)).toBe(true)
		expect(Object.isFrozen(product.legalLinks?.[0])).toBe(true)
	})

	it('rejects ambiguous strings, unsafe links, unknown fields, and oversized collections', () => {
		expect(() => defineProduct({ displayName: ' Rhythm' })).toThrow('surrounding whitespace')
		expect(() =>
			defineProduct({
				displayName: 'Rhythm',
				legalLinks: [{ label: 'bad', href: '//example.com/legal' }],
			}),
		).toThrow('protocol-relative')
		expect(() =>
			defineProduct({
				displayName: 'Rhythm',
				legalLinks: [{ label: 'bad', href: 'javascript:alert(1)' }],
			}),
		).toThrow('must use http: or https:')
		expect(() => defineProduct({ displayName: 'Rhythm', extra: true } as never)).toThrow(
			'unsupported "extra"',
		)
		expect(() =>
			defineProduct({
				displayName: 'Rhythm',
				legalLinks: Array.from({ length: 9 }, (_, index) => ({
					label: String(index),
					href: `/legal/${index}`,
				})),
			}),
		).toThrow('at most 8')
	})

	it('rejects accessors without invoking them', () => {
		const displayName = vi.fn(() => 'Rhythm')
		const product = Object.defineProperty({}, 'displayName', { get: displayName })
		expect(() => defineProduct(product as never)).toThrow('must be a data property')
		expect(displayName).not.toHaveBeenCalled()
	})
})
