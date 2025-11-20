export type PatternScheme = 'light' | 'dark'

type PatternStyle = {
	backgroundColor: string
	backgroundImage: string
	backgroundSize: string
	backgroundPosition?: string
	backgroundAttachment?: string
}

export const patternBackgrounds: Record<PatternScheme, PatternStyle> = {
	light: {
		backgroundColor: '#f5f7fb',
		backgroundImage: `
			linear-gradient(to right, rgba(220, 225, 235, 0.6) 1px, transparent 1px),
			linear-gradient(to bottom, rgba(220, 225, 235, 0.6) 1px, transparent 1px),
			radial-gradient(circle 520px at 0% 20%, rgba(99, 179, 237, 0.16), transparent 60%),
			radial-gradient(circle 520px at 100% 0%, rgba(52, 211, 235, 0.12), transparent 60%)
		`,
		backgroundSize: '48px 48px, 48px 48px, 100% 100%, 100% 100%',
	},
	dark: {
		backgroundColor: '#0b1220',
		backgroundImage: `
			linear-gradient(to right, rgba(34, 45, 64, 0.45) 1px, transparent 1px),
			linear-gradient(to bottom, rgba(34, 45, 64, 0.45) 1px, transparent 1px),
			radial-gradient(circle 560px at 15% 0%, rgba(96, 165, 250, 0.22), transparent 55%),
			radial-gradient(circle 560px at 85% 0%, rgba(45, 212, 191, 0.18), transparent 55%)
		`,
		backgroundSize: '48px 48px, 48px 48px, 100% 100%, 100% 100%',
	},
}

export const getPatternStyle = (scheme: PatternScheme) => patternBackgrounds[scheme]
