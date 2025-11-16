export default {
	entry: 'src/index.ts',
	format: ['esm'],
	dts: false,
	external: ['acme-plugin-alpha', 'acme-plugin-beta'],
	sourcemap: false,
	clean: true,
}
