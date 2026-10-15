import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../../scripts/vite-tasks'

export default defineConfig({
	run: {
		tasks: repositoryTasks('@embedded-launcher/sdk', {
			typecheck: 'tsc --noEmit',
		}),
	},
})
