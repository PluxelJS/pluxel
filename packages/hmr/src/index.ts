import { setPluxelRuntime } from '@pluxel/core'

setPluxelRuntime('hmr')

// Type-level bridge for `Context.Config` (module augmentation) for dev-only keys.
// oxlint-disable-next-line import/no-empty-named-blocks -- Type-only bridge keeps the augmentation file in the TS graph without a runtime import.
import type {} from './dev/context-augment'

export { applyHmrEnvOverrides } from './dev/runtime'
export { attachHmrRuntime, startHmrRuntime } from './dev/attach-runtime'
export { createFetchDevServerPlugin } from './dev/vite-fetch-plugin'
export { HMRService } from './dev/hmr/HMRService'
export {
	buildHmrViteConfig,
	resolveFsAllowList,
	resolveHMRDependencyConfig,
} from './dev/hmr/config'
export type { HMRDependencyConfig } from './dev/hmr/config'
