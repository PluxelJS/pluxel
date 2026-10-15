import { defineConfig } from 'vite-plus'
export default defineConfig({
	run: { tasks: { 'check-types': { command: 'tsc --noEmit --pretty false' } } },
})
