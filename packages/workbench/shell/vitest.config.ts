import { defineConfig } from 'vitest/config'
import { PLUXEL_UI_DEDUPE_PACKAGES } from '@pluxel/rolldown/workspace/vite'

const pluxelConditions = ['development', '@pluxel/source', 'node', 'import', 'module', 'default']

export default defineConfig({
	root: import.meta.dirname,
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
