import { defineConfig } from 'vite-plus/pack'

// Only the Electron carrier is compiled here. Plugin source is owned by host-vite.
export default defineConfig([
	{
		entry: {
			main: 'src/electron/main.ts',
			backend: 'src/electron/backend.ts',
		},
		outDir: '.studio-dev/electron',
		format: 'esm',
		dts: false,
		sourcemap: true,
		clean: true,
		deps: { neverBundle: ['electron', /^@pluxel\//, /(?:^|\/)backend\/runtime\.ts$/] },
	},
	{
		entry: { preload: 'src/electron/preload.ts' },
		outDir: '.studio-dev/electron',
		format: 'cjs',
		dts: false,
		clean: false,
		deps: { neverBundle: ['electron'] },
	},
])
