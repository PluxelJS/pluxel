import { staticApplication } from '@pluxel/rolldown/build'

export default {
	...staticApplication({
		entry: './src/pluxel.static.ts',
		variant: 'workbench',
		target: 'node',
	}),
	copy: [
		{
			from: './web/dist',
			to: 'dist',
			rename: 'public',
		},
	],
}
