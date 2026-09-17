import { defineConfig } from 'tsdown'
import { pluxel } from '@pluxel/rolldown'

export default defineConfig({
	entry: './src/app.ts',
	plugins: [
		pluxel({
			variant: 'workbench',
			sourceFrameworks: [
				'@pluxel/services/http',
				'@pluxel/services/node',
				'@pluxel/services/workers',
				'@pluxel/services/commands',
				'@pluxel/services/persistence',
				'@pluxel/services/vault',
				'@pluxel/management/access',
				'@pluxel/workbench',
				'@pluxel/workbench/federation',
				'elysia',
				'elysia/ws',
				'@pluxel/commands',
			],
		}),
	],
})
