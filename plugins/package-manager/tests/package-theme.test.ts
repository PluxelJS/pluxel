import { expect, it } from 'vitest'
import { workbenchTheme } from '@pluxel/workbench/mantine'
import { packageColors } from '../src/ui/package-theme.ts'

it('matches the Workbench swatches in a provider-free marketplace', () => {
	const fallbacks: string[] = []
	const themeColors: string[] = []
	for (const colors of Object.values(packageColors)) {
		for (const index of [0, 2] as const) {
			const swatch = /^--mantine-color-(\w+)-(\d)$/.exec(colors[index])
			if (!swatch) continue
			fallbacks.push(colors[index + 1])
			themeColors.push(workbenchTheme.colors[swatch[1]!][Number(swatch[2])]!)
		}
	}
	expect(fallbacks.length).toBeGreaterThan(0)
	expect(fallbacks).toEqual(themeColors)
})

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
const luminance = (channels: number[]) =>
	channels.reduce(
		(sum, v, i) =>
			sum +
			[0.2126, 0.7152, 0.0722][i]! * (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4),
		0,
	)
function contrast(a: number[], b: number[]) {
	const x = luminance(a),
		y = luminance(b)
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
it.each([
	['light', 1],
	['dark', 3],
] as const)('keeps package text and interactive boundaries legible on %s surfaces', (_, index) => {
	const color = (name: keyof typeof packageColors) => rgb(packageColors[name][index])
	const canvas = color('canvas')
	const surfaces = [
		canvas,
		color('surface'),
		...(['accent', 'positive', 'error'] as const).map((key) =>
			color(key).map((v, i) => 0.09 * v + 0.91 * canvas[i]!),
		),
	]
	for (const bg of surfaces) {
		for (const role of ['ink', 'muted', 'accent', 'positive', 'error'] as const)
			expect(contrast(color(role), bg)).toBeGreaterThanOrEqual(4.5)
		expect(contrast(color('control'), bg)).toBeGreaterThanOrEqual(3)
	}
	expect(contrast(color('on-filled'), color('filled'))).toBeGreaterThanOrEqual(4.5)
})
