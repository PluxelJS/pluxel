import { mergeConfig, type InlineConfig } from 'vite'
import './context-augment'

import type { ManagementCompilerServiceConfig } from './management/ManagementCompilerService'

export * from './hmr-log'
export {
	ManagementCompilerService,
	type ManagementCompilerServiceConfig,
	type ManagementCompilerServiceDeps,
} from './management/ManagementCompilerService'

export function mergeManagementCompilerViteConfig(
	base: ManagementCompilerServiceConfig | undefined,
	vite: InlineConfig | undefined,
): ManagementCompilerServiceConfig | undefined {
	if (!vite) return base
	return {
		...base,
		vite: base?.vite ? mergeConfig(base.vite, vite) : vite,
	}
}
