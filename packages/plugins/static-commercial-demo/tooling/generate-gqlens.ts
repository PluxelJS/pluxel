import { generateGQLensFiles } from '@gqlens/vite'
import { createSchemaSDL } from '../src/schema.ts'

const stats = await generateGQLensFiles({
	schema: createSchemaSDL(),
	framework: 'react',
	output: 'web/gqlens',
})

console.info(`Generated ${stats.total} GQLens files (${stats.changed} changed).`)
