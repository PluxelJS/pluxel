import { defineConfig } from 'tsdown'
import { pluxel } from '@pluxel/rolldown'

export default defineConfig({
	entry: './src/app.ts',
	plugins: [pluxel({ delivery: 'modules' })],
})
