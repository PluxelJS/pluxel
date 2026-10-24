import packConfig from './tsdown.config'
import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../../scripts/vite-tasks'

const tasks = repositoryTasks({
	compile: 'pluxel build',
	'check-tests': 'vp test run --config vitest.config.ts',
	'check-types': 'tsc --noEmit --pretty false',
})

// Vite Task does not include relative development links in its workspace dependency graph.
for (const name of ['compile', 'check-tests', 'check-types'] as const) {
	const task = tasks[name]!
	task.dependsOn = [...(task.dependsOn ?? []), '@pluxel/plugin-typst#compile']
}

export default defineConfig({
	pack: packConfig,
	run: { tasks },
})
