import { defineConfig } from 'vite-plus'
import { repositoryTasks } from '../../scripts/vite-tasks'

export default defineConfig({
	run: {
		tasks: repositoryTasks({
			compile: {
				command: 'node scripts/verify-shell.mjs',
				dependsOn: ['compile-lib'],
				cache: {
					output: [],
				},
			},
			'prepare-i18n': {
				command: 'node scripts/prepare-i18n.mjs',
				dependsOn: ['@pluxel/rolldown#compile'],
				cache: { output: ['.pluxel/i18n/**'] },
			},
			'check-types': {
				command:
					'tsc --noEmit --pretty false && tsc --noEmit --pretty false -p shell/tsconfig.json',
				dependsOn: [
					'prepare-i18n',
					{ task: 'compile', from: ['dependencies', 'devDependencies', 'peerDependencies'] },
				],
			},
			'check-tests': 'vp test run && vp test run --config shell/vitest.config.ts',
			'check-native': {
				command: 'node ../../scripts/check-worksplit-native.mjs .',
				dependsOn: ['@worksplit/react#compile'],
				cache: false,
			},
			'compile-web': {
				command: 'vp build --config vite.shell.config.ts',
				dependsOn: [
					'check-native',
					'prepare-i18n',
					'@pluxel/services#compile',
					'@pluxel/rolldown#compile',
					'@worksplit/react#compile',
					'valibot-form#compile',
				],
			},
			'compile-lib': {
				command: 'node ../../scripts/pack.mjs',
				dependsOn: ['compile-web'],
			},
		}),
	},
})
