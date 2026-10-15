import { defineConfig } from 'vite-plus/pack'
import { pluxel } from '@pluxel/rolldown'

export default defineConfig({
	entry: './src/app.ts',
	plugins: [pluxel({ delivery: 'modules' })],
	copy: [
		{
			from: './web/dist',
			to: 'dist',
			rename: 'public',
		},
	],
})
