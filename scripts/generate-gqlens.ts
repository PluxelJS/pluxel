import { generateGQLensFiles } from '@gqlens/vite'

import gqlensEntry from '../packages/workbench-app/src/app/gqlens/graphql-entry.ts'

await generateGQLensFiles({
	schema: await gqlensEntry.schema(),
	framework: 'react',
	output: 'packages/workbench-app/src/app/gqlens',
})
