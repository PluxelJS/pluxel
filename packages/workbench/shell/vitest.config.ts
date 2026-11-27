import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { pluxelParaglideVitePlugin } from '@pluxel/rolldown/vite/paraglide'
import { PLUXEL_UI_DEDUPE_PACKAGES } from '@pluxel/rolldown/workspace/vite'

const pluxelConditions = ['development', '@pluxel/source', 'node', 'import', 'module', 'default']

export default defineConfig({
	root: import.meta.dirname,
	plugins: [pluxelParaglideVitePlugin({ root: fileURLToPath(new URL('..', import.meta.url)) })],
	resolve: {
		conditions: pluxelConditions,
		dedupe: [...PLUXEL_UI_DEDUPE_PACKAGES],
	},
	ssr: {
		resolve: {
			conditions: pluxelConditions,
		},
		noExternal: ['@pluxel/workbench', '@material/material-color-utilities'],
	},
	test: {
		include: ['tests/**/*.test.{ts,tsx}'],
		// Each UI worker initializes its own DOM and React application dependencies.
		maxWorkers: 2,
		server: {
			deps: { inline: ['@pluxel/workbench', '@material/material-color-utilities'] },
		},
	},
})
