import { definePluxelVitestConfig } from '@pluxel/test/vitest'

export default definePluxelVitestConfig({
	test: {
		passWithNoTests: false,
		// Each fixture owns its installation root. Turbo's pnpm scheduling override
		// is not part of the application environment exercised by these native tests.
		env: {
			PNPM_CONFIG_WORKSPACE_DIR: '',
			pnpm_config_workspace_dir: '',
			NPM_CONFIG_WORKSPACE_DIR: '',
			npm_config_workspace_dir: '',
		},
	},
	pluxel: {
		include: ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts'],
		exclude: ['node_modules/**', 'dist/**', '**/*.d.ts'],
	},
})
