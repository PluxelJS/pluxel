export * from './runner.ts'

export { hostSingletons } from './singletons.ts'
export { beginHostCandidate } from './candidate.ts'
export { invalidateHostChangedModules } from './invalidation.ts'
export { ViteApplicationRecovery } from './internal/vite-application-recovery.ts'

export { createHostSourceEvaluator, type HostSourceCandidate } from './application-sources'
export { host, type HostViteOptions } from './host-vite.ts'

export {
	createHostModuleClassifier,
	createHostModuleVitePlugin,
	type HostModuleClassifier,
	type HostModuleDecision,
} from './host-modules.ts'

export type {
	HostDevelopmentPluginApi,
	HostDevelopmentCatalog,
	HostDevelopmentAttachment,
	HostDevelopmentCandidate,
} from './attachments'
