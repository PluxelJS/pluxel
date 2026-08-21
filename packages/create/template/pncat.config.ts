import { defineConfig } from 'pncat'

export default defineConfig({
	catalogRules: [
		{
			name: 'pluxel',
			match: [/^@pluxel\//],
			priority: 10,
		},
		{
			name: 'frontend',
			match: [
				/^@mantine\//,
				/^@tabler\//,
				/^@types\/react(?:-dom)?$/,
				'@vitejs/plugin-react',
				'react',
				'react-dom',
			],
			priority: 20,
		},
		{
			name: 'test',
			match: ['vitest'],
			priority: 30,
		},
		{
			name: 'backend',
			match: ['elysia'],
			priority: 40,
		},
		{
			name: 'tooling',
			match: ['@types/node', 'oxfmt', 'oxlint', 'pncat', 'tsdown', 'turbo', 'typescript', 'vite'],
			priority: 50,
		},
	],
})
