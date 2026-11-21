import { defineConfig } from 'vite-plus'
import pack from './tsdown.config'
import { repositoryTasks } from '../../../scripts/vite-tasks'

export default defineConfig({
	pack,
	run: { tasks: repositoryTasks({ compile: 'pluxel build' }) },
})
