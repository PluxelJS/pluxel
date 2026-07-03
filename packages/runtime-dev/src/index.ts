import { mergeConfig, type InlineConfig } from 'vite'
import './context-augment'

import type { ExtensionCompilerServiceConfig } from './extensions/ExtensionCompilerService'

export * from './hmr-log'
export {
	ExtensionCompilerService,
	type ExtensionCompilerServiceConfig,
	type ExtensionCompilerServiceDeps,
} from './extensions/ExtensionCompilerService'

export function mergeExtensionCompilerViteConfig(
	base: ExtensionCompilerServiceConfig | undefined,
	vite: InlineConfig | undefined,
): ExtensionCompilerServiceConfig | undefined {
	if (!vite) return base
	return {
		...base,
		vite: base?.vite ? mergeConfig(base.vite, vite) : vite,
	}
}
