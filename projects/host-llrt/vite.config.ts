import { defineConfig } from 'vite-plus'
import pack from './tsdown.config'

const dependencyFields = ['dependencies', 'devDependencies', 'peerDependencies'] as const
const dependencies = dependencyFields.map((from) => ({ task: 'compile', from }))

export default defineConfig({
	pack,
	run: {
		tasks: {
			compile: {
				command: 'node scripts/bundle.mjs',
				dependsOn: dependencies,
				cache: false,
			},
			'compile-plugin': {
				command: 'pluxel build',
				dependsOn: dependencies,
				cache: false,
			},
			'check-types': {
				command: 'tsc --noEmit',
				dependsOn: dependencies,
			},
			'check-smoke': {
				command: 'node scripts/prepare-runtime.mjs && node scripts/check-smoke.mjs',
				dependsOn: ['compile'],
				cache: false,
			},
		},
	},
})
