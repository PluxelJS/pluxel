import react from '@vitejs/plugin-react'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { fixRolldownUndefinedExportsPlugin } from '../../workspace/src/vite'
import type { PluginOption } from 'vite'

export function createWorkbenchFrontendPlugins(): PluginOption[] {
	return [
		tanstackRouter({
			target: 'react',
			autoCodeSplitting: true,
			routesDirectory: './src/app/router/routes',
			generatedRouteTree: './src/app/router/routeTree.gen.ts',
		}),
		react(),
		fixRolldownUndefinedExportsPlugin(),
	]
}
