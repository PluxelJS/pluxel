import { resolve } from 'node:path'
import { definePluxelVitestConfig } from '@pluxel/test/vitest'

const packageAlias = (name: string) => ({
	find: new RegExp(`^@repo/chatbots-${name}$`),
	replacement: resolve(import.meta.dirname, `packages/${name}/src/index.ts`),
})

const packageSubpathAlias = (name: string) => ({
	find: new RegExp(`^@repo/chatbots-${name}/(.+)$`),
	replacement: resolve(import.meta.dirname, `packages/${name}/src/$1.ts`),
})

export default definePluxelVitestConfig({
	root: import.meta.dirname,
	resolve: {
		alias: [
			packageAlias('access'),
			packageSubpathAlias('adapter-kit'),
			packageAlias('contracts'),
			packageAlias('hub'),
			packageAlias('commands'),
			packageAlias('kook'),
			packageAlias('kook-hub'),
			packageAlias('telegram'),
			packageAlias('telegram-hub'),
		],
	},
	oxc: {
		decorator: {
			legacy: true,
		},
	},
	test: { include: ['packages/*/tests/**/*.test.ts', 'test/**/*.test.ts'] },
})
