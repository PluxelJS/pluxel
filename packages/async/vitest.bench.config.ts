import { defineConfig } from 'vitest/config'

// Compare built ESM against built ESM. Native Node loading avoids source conditions
// and Vite module-export getters in the measured code; unit tests keep their source config.
export default defineConfig({
	test: {
		experimental: { viteModuleRunner: false },
		fileParallelism: false,
		reporters: ['verbose'],
		silent: false,
	},
})
