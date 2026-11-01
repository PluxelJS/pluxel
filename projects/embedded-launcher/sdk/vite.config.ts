import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../../scripts/vite-tasks'

export default defineConfig({
	pack: {
		entry: { index: './src/index.ts' },
		format: 'esm',
		outDir: 'dist',
		fixedExtension: true,
		// Preserve the previous Rolldown ESM build's default platform and explicit conditions.
		platform: 'browser',
		target: false,
		deps: { neverBundle: /^@pluxel\// },
		inputOptions: { resolve: { conditionNames: ['@pluxel/source', 'import', 'default'] } },
		dts: false,
		minify: false,
		sourcemap: false,
		clean: false,
		exports: false,
	},
	run: {
		tasks: repositoryTasks({
			compile: {
				command: 'vp pack',
				dependsOn: ['@pluxel/core#compile', '@pluxel/host#compile'],
				cache: { output: ['dist/**'] },
			},
			'check-types': 'tsc --noEmit',
		}),
	},
})
