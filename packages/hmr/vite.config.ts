// vite.config.ts

import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
	// 关键：不再寻找 index.html
	appType: 'custom',

	// SSR 这边外部化 react/react-dom（看你之前的配置）
	ssr: { external: ['react', 'react-dom'] },

	build: {
		outDir: 'public/',
		manifest: true, // 生产产物生成 manifest.json
		emptyOutDir: true,
		rollupOptions: {
			// 关键：以 JS/TS 为入口
			input: path.resolve(__dirname, 'src/client.tsx'),
		},
	},
})
