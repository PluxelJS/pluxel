import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

const pluginBuilds = [
	'@embedded-launcher/sdk#compile',
	'@pluxel/commands#compile',
	'@pluxel/services#compile',
	'@pluxel/rolldown#compile',
]

export default defineConfig({
	run: {
		tasks: repositoryTasks({
			'compile-plugins': {
				command: 'node build/plugins.mjs',
				dependsOn: pluginBuilds,
				cache: { output: ['dist/**'] },
			},
			'compile-release': {
				command: 'node build/release.mjs',
				dependsOn: pluginBuilds,
				cache: { output: ['release/**'] },
			},
			'check-types': 'tsc --noEmit',
			'check-tests': 'vp test run',
		}),
	},
})
