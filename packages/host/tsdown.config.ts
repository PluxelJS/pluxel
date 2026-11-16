import { defineConfig } from 'vite-plus/pack'

export default defineConfig({
	exports: { devExports: '@pluxel/source' },
	entry: {
		'internal/agent-types': './src/agent.ts',
		'internal/agent/host': './src/agent-host.ts',
		'internal/agent/runtime': './src/agent-runtime.ts',
		'internal/agent/socket': './src/agent/socket.ts',
		'internal/agent/transport': './src/agent/transport.ts',
		'internal/agent/node': './src/agent/node.ts',
		bindings: './src/bindings.ts',
		browser: './src/browser.ts',
		environment: './src/environment.ts',
		sources: './src/sources.ts',
		index: './src/index.ts',
		internal: './src/internal.ts',
		'internal/protocol': './src/protocol.ts',
		'internal/control-manifest': './src/control-manifest.ts',
		'internal/control-reference': './src/control-reference.ts',
		'internal/shared-runtime': './src/shared-runtime.ts',
	},
	format: ['esm'],
	dts: { eager: true },
	clean: true,
	treeshake: true,
})
