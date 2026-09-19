import { defineConfig } from 'tsdown'
import { buildPreset } from '@pluxel/preset/build'

export default defineConfig({
	entry: './src/app.ts',
	plugins: [buildPreset()],
})
