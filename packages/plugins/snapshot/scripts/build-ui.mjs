import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildPluginUiRemote } from '@pluxel/hmr/plugin-build'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

await buildPluginUiRemote({
	root,
	pluginName: 'Snapshot',
	entryPath: 'src/ui/index.tsx',
})
