import * as v from 'valibot'

export const money = v.pipe(v.string(), v.regex(/^-?\d{1,16}(?:\.\d{1,2})?$/))
export const date = v.pipe(
	v.string(),
	v.regex(/^\d{4}-\d{2}-\d{2}$/),
	v.check((value) => {
		const parsed = new Date(`${value}T00:00:00.000Z`)
		return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
	}),
)
export function cents(value: string): bigint {
	const negative = value.startsWith('-')
	const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.')
	return (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * (negative ? -1n : 1n)
}
