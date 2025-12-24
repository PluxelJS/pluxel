import type { GraphQLConfig } from 'packages/core/src/services'
import type { GraphQLService } from './GraphQLService'
import type { HonoService } from './HonoService'

export * from './env'
export * from './GraphQLService'
export * from './HonoService'
export * from './InternalGraphQLService'

const graphqlName = "graphql" as const
const honoName = 'honoService' as const
declare module '@pluxel/core' {
    namespace Context {
        interface Services {
            [graphqlName]: GraphQLService
            [honoName]: HonoService
        }
    }
    export namespace Context {
        interface Config {
            [graphqlName]?: GraphQLConfig
        }
    }
}
