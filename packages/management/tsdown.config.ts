import { defineConfig } from 'tsdown'
export default defineConfig({
	entry: {
		index: 'src/index.ts',
		client: 'src/client.ts',
		protocol: 'src/protocol.ts',
		react: 'src/react.ts',
		session: 'src/web/session/index.ts',
		product: 'src/product-contract.ts',
		access: 'src/access.ts',
		service: 'src/service.ts',
		http: 'src/http.ts',
		commands: 'src/commands.ts',
		internal: 'src/internal.ts',
		'internal/http': 'src/http-internal.ts',
		'internal/test': 'src/test-internal.ts',
	},
	dts: true,
	format: ['esm'],
	clean: true,
	sourcemap: true,
})
