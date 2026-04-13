import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// Vitest Projects (workspace): each config file is treated as a separate project.
		projects: ['packages/**/vitest.config.ts'],
	},
})
