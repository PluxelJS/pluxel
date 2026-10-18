import { defineConfig } from 'vite-plus'
import lint from './oxlint.config'
import fmt from './oxfmt.config'

export default defineConfig({
	fmt,
	lint: { ...lint, options: { typeAware: true, typeCheck: true } },
	run: {
		cache: { scripts: false, tasks: true },
		tasks: {
			'governance:check': {
				command: 'pluxel workspace doctor && node scripts/check-workspace-governance.mjs',
				cache: false,
			},
			'verify:checks': { command: 'vp check', cache: false },
			'workspace:build': { command: [], dependsOn: ['@example/host#compile'] },
			'workspace:test': {
				command: [],
				dependsOn: [
					'@example/domain#check-tests',
					'@example/audit-plugin#check-tests',
					'@example/http-plugin#check-tests',
					'@example/todo-plugin#check-tests',
				],
			},
			'workspace:verify': {
				command: [],
				cache: false,
				dependsOn: ['governance:check', 'verify:checks', 'workspace:test', 'workspace:build'],
			},
		},
	},
})
