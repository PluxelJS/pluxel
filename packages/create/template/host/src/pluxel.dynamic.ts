import { resolve } from 'node:path'
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'
import { product } from './product'
import { exampleConfigService, examplePlugins, exampleRuntimeState } from './runtime-state'

export { product }

const root = resolve(import.meta.dirname, '../..')

export default defineDynamicRuntimeConfig({
	root,
	configPath: 'pluxel.loader.hmr.jsonc',
	profile: 'example',
	plugins: examplePlugins,
	sources: [
		{
			kind: 'directory',
			path: '.pluxel/managed-plugins',
			include: ['*.mjs'],
		},
	],
	configService: exampleConfigService(),
	runtimeState: exampleRuntimeState(),
	workbench: { enabled: true, uiBasePath: '/__pluxel/workbench' },
})
