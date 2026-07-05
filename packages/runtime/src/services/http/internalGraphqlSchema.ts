import { query, type Resolver, resolver, weave } from '@gqloom/core'
import { ValibotWeaver } from '@gqloom/valibot'
import type { Context as PlxContext } from '@pluxel/core'
import { printSchema, type GraphQLSchema } from 'graphql'
import * as v from 'valibot'

import { getAPISchema } from '../../api'

function createInternalGraphQLBaseResolvers(): Resolver[] {
	return [
		resolver({
			_empty: query(v.string()).resolve(() => 'ok'),
		}),
	]
}

export function createInternalGraphQLSchema(ctx: PlxContext): GraphQLSchema {
	return weave(ValibotWeaver, ...createInternalGraphQLBaseResolvers(), ...getAPISchema(ctx))
}

export function createInternalGraphQLSchemaSDL(ctx: PlxContext): string {
	return printSchema(createInternalGraphQLSchema(ctx))
}
