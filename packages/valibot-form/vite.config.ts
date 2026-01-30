import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
	resolve: {
		tsconfigPaths: true,
		dedupe: ['react', 'react-dom', '@mantine/core', '@mantine/hooks'],
		alias: {
			'@tabler/icons-react': '@tabler/icons-react/dist/esm/icons/index.mjs',
		},
	},
	plugins: [react()],
	optimizeDeps: {
		include: ['react', 'react-dom', '@mantine/core', '@mantine/hooks', '@tabler/icons-react'],
	},
})
