import type { MantineColorsTuple } from '@mantine/core'
import {
	CorePalette,
	Hct,
	SchemeTonalSpot,
	argbFromHex,
	hexFromArgb,
	type TonalPalette,
} from '@material/material-color-utilities'

export type PlxMaterialMode = 'light' | 'dark'
export type PlxMaterialPaletteKey = 'a1' | 'a2' | 'a3' | 'n1' | 'n2' | 'error'

const MANTINE_SCALE_TONES = [98, 96, 92, 86, 76, 64, 52, 40, 30, 20] as const
const MANTINE_DARK_SCALE_TONES = [90, 82, 72, 64, 56, 44, 34, 26, 20, 14] as const

export function alpha(hex: string, opacity: number) {
	const normalized = hex.replace('#', '')
	const value =
		normalized.length === 3
			? normalized
					.split('')
					.map((part) => `${part}${part}`)
					.join('')
			: normalized
	const red = Number.parseInt(value.slice(0, 2), 16)
	const green = Number.parseInt(value.slice(2, 4), 16)
	const blue = Number.parseInt(value.slice(4, 6), 16)
	return `rgba(${red}, ${green}, ${blue}, ${opacity})`
}

export function mix(hexA: string, hexB: string, weightB: number) {
	const normalize = (input: string) => {
		const normalized = input.replace('#', '')
		return normalized.length === 3
			? normalized
					.split('')
					.map((part) => `${part}${part}`)
					.join('')
			: normalized
	}
	const a = normalize(hexA)
	const b = normalize(hexB)
	const ratio = Math.min(1, Math.max(0, weightB))
	const blend = (index: number) => {
		const av = Number.parseInt(a.slice(index, index + 2), 16)
		const bv = Number.parseInt(b.slice(index, index + 2), 16)
		return Math.round(av * (1 - ratio) + bv * ratio)
			.toString(16)
			.padStart(2, '0')
	}
	return `#${blend(0)}${blend(2)}${blend(4)}`
}

export function toneHex(palette: TonalPalette, tone: number) {
	return hexFromArgb(palette.tone(tone))
}

export function createMantinePaletteFromTonalPalette(palette: TonalPalette): MantineColorsTuple {
	return MANTINE_SCALE_TONES.map((tone) => toneHex(palette, tone)) as unknown as MantineColorsTuple
}

export function createMantineDarkPaletteFromTonalPalette(
	palette: TonalPalette,
): MantineColorsTuple {
	return MANTINE_DARK_SCALE_TONES.map((tone) =>
		toneHex(palette, tone),
	) as unknown as MantineColorsTuple
}

export function createMantinePaletteFromSeed(
	seedHex: string,
	paletteKey: PlxMaterialPaletteKey = 'a1',
): MantineColorsTuple {
	const core = CorePalette.of(argbFromHex(seedHex))
	return createMantinePaletteFromTonalPalette(core[paletteKey])
}

export function createMaterialThemeSource(seedHex: string) {
	const source = argbFromHex(seedHex)
	const hct = Hct.fromInt(source)
	const core = CorePalette.of(source)
	return {
		source,
		hct,
		core,
		light: new SchemeTonalSpot(hct, false, 0),
		dark: new SchemeTonalSpot(hct, true, 0),
	}
}
