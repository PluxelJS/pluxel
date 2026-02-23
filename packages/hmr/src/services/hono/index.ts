import type { HonoService } from './HonoService'

export * from './env'
export * from './HonoService'
export * from './InternalGraphQLService'

const honoName = 'honoService' as const
declare module '@pluxel/core' {
	namespace Context {
		interface Services {
			[honoName]: HonoService
		}
	}
}
