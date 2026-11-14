import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
	exports: { devExports: '@pluxel/source' },
	entry: {
		agent: './src/agent.ts',
		'agent/socket': './src/agent/socket.ts',
		'agent/transport': './src/agent/transport.ts',
		'agent/node': './src/agent/node.ts',
		bindings: './src/bindings.ts',
		browser: './src/browser.ts',
		environment: './src/environment.ts',
		sources: './src/sources.ts',
		index: './src/index.ts',
		internal: './src/internal.ts',
		'internal/protocol': './src/execution.ts',
		'internal/control-manifest': './src/control-manifest.ts',
		'internal/shared-runtime': './src/shared-runtime.ts',
	},
	format: ['esm'],
	dts: { eager: true },
	clean: true,
	treeshake: true,
})
