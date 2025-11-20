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
		backgroundColor: '#f8fafc',
		backgroundImage: `
			linear-gradient(to right, rgba(228, 232, 240, 0.65) 1px, transparent 1px),
			linear-gradient(to bottom, rgba(228, 232, 240, 0.65) 1px, transparent 1px),
			radial-gradient(circle 520px at 0% 20%, rgba(139, 92, 246, 0.18), transparent 60%),
			radial-gradient(circle 520px at 100% 0%, rgba(59, 130, 246, 0.16), transparent 60%)
		`,
		backgroundSize: '48px 48px, 48px 48px, 100% 100%, 100% 100%',
	},
	dark: {
		backgroundColor: '#020617',
		backgroundImage: `
			linear-gradient(to right, rgba(30, 41, 59, 0.45) 1px, transparent 1px),
			linear-gradient(to bottom, rgba(30, 41, 59, 0.45) 1px, transparent 1px),
			radial-gradient(circle 560px at 15% 0%, rgba(99, 102, 241, 0.22), transparent 55%),
			radial-gradient(circle 560px at 85% 0%, rgba(14, 165, 233, 0.2), transparent 55%)
		`,
		backgroundSize: '48px 48px, 48px 48px, 100% 100%, 100% 100%',
	},
}

export const getPatternStyle = (scheme: PatternScheme) => patternBackgrounds[scheme]
