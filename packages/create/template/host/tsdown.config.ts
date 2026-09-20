import { defineConfig } from 'tsdown'
import { buildPreset } from '@pluxel/services/build'

export default defineConfig({
	entry: './src/app.ts',
	plugins: [buildPreset()],
	copy: [
		{
			from: './web/dist',
			to: 'dist',
			rename: 'public',
		},
	],
})
