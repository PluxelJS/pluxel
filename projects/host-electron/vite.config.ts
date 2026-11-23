import { defineConfig } from 'vite-plus'
import pack from './tsdown.config'

export default defineConfig({
	pack,
	run: {
		tasks: {
			compile: {
				command: 'pluxel build',
				dependsOn: [
					{ task: 'compile', from: ['dependencies', 'devDependencies', 'peerDependencies'] },
				],
				cache: { output: ['dist/**'] },
			},
			'check-types': { command: 'tsc --noEmit --pretty false', dependsOn: ['compile'] },
		},
	},
})
