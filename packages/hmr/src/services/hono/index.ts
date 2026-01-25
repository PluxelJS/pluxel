import type { HonoService } from './HonoService'

export * from './env'
export * from './HonoService'
// NOTE: SOURCE_ONLY preprocessor blocks are stripped by tsdown for non-source builds.
// Do NOT remove them or rewrite this into runtime conditions.
//#if SOURCE_ONLY
export * from './InternalGraphQLService'
//#endif

const honoName = 'honoService' as const
declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[honoName]: HonoService
		}
	}
}
