import { mergeConfig, type InlineConfig } from 'vite'
import './context-augment'

import type { WorkbenchCompilerServiceConfig } from './workbench/WorkbenchCompilerService'

export * from './hmr-log'
export {
	WorkbenchCompilerService,
	type WorkbenchCompilerServiceConfig,
	type WorkbenchCompilerServiceDeps,
} from './workbench/WorkbenchCompilerService'

export function mergeWorkbenchCompilerViteConfig(
	base: WorkbenchCompilerServiceConfig | undefined,
	vite: InlineConfig | undefined,
): WorkbenchCompilerServiceConfig | undefined {
	if (!vite) return base
	return {
		...base,
		vite: base?.vite ? mergeConfig(base.vite, vite) : vite,
	}
}
