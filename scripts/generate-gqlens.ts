import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { generateFiles } from '@gqlens/codegen'

import gqlensEntry from '../packages/components/src/app/gqlens/graphql-entry.ts'

const files = await generateFiles({
	schema: await gqlensEntry.schema(),
	framework: 'react',
})

const outputDir = join(process.cwd(), 'packages/components/src/app/gqlens')
for (const [name, content] of Object.entries(files)) {
	const file = join(outputDir, name)
	await mkdir(dirname(file), { recursive: true })
	await writeFile(file, content, 'utf8')
}
