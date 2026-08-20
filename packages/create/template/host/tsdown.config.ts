import { staticApplication } from '@pluxel/rolldown/build'
import { defineConfig } from 'tsdown'

export default defineConfig({
	...staticApplication({
		entry: './src/pluxel.static.ts',
		variant: 'workbench',
		target: 'node',
	}),
	copy: [
		{
			from: './web/dist',
			to: 'dist',
			rename: 'public',
		},
	],
})
