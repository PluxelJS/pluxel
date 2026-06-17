import { defineGQLensEntry } from '@gqlens/vite/entry'
import { commercialGraphQLEndpoint } from './paths.ts'
import { createSchemaSDL } from './schema.ts'

export default defineGQLensEntry({
	schema: createSchemaSDL,
	handler: () => {
		throw new Error(
			`GraphQL is served by Pluxel runtime-static at ${commercialGraphQLEndpoint}; keep @gqlens/vite middleware disabled.`,
		)
	},
})
