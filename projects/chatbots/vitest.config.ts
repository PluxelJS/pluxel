import { resolve } from 'node:path'
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

const packageAlias = (name: string) => ({
	find: new RegExp(`^@repo/chatbots-${name}$`),
	replacement: resolve(import.meta.dirname, `packages/${name}/src/index.ts`),
})

export default definePluxelVitestConfig({
	root: import.meta.dirname,
	resolve: {
		alias: [
			packageAlias('access'),
			packageAlias('contracts'),
			packageAlias('hub'),
			packageAlias('commands'),
		],
	},
	oxc: {
		decorator: {
			legacy: true,
		},
	},
	test: { include: ['packages/*/tests/**/*.test.ts'] },
})
