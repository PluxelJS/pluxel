import { generateGQLensFiles } from '@gqlens/vite'

import gqlensEntry from '../packages/components/src/app/gqlens/graphql-entry.ts'

await generateGQLensFiles({
	schema: await gqlensEntry.schema(),
	framework: 'react',
	output: 'packages/components/src/app/gqlens',
})
