import { fixRolldownUndefinedExportsPlugin } from '@pluxel/rolldown/workspace/vite'
import type { PluginOption } from 'vite'

export function createRuntimeWebPlugins(): PluginOption[] {
	return [fixRolldownUndefinedExportsPlugin()]
}
