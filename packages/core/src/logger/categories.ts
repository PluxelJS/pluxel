export const pluxelCategories = {
	core: ['pluxel', 'core'],
	hmr: ['pluxel', 'hmr'],
	plugins: ['pluxel', 'plugins'],
} as const

export type PluxelCategory = (typeof pluxelCategories)[keyof typeof pluxelCategories]

