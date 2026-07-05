import { generateFiles } from '@gqlens/codegen'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createSchemaSDL } from '../src/schema.ts'

async function readText(path: string): Promise<string | undefined> {
	return readFile(path, 'utf8').catch(ignoreMissingText)
}

function ignoreMissingText(): undefined {
	return undefined
}

const outputDir = 'web/gqlens'
const files = await generateFiles({
	schema: createSchemaSDL(),
	framework: 'react',
})

let changed = 0

for (const [path, content] of Object.entries(files)) {
	const target = join(outputDir, path)
	await mkdir(dirname(target), { recursive: true })
	const previous = await readText(target)
	if (previous !== content) {
		await writeFile(target, content)
		changed++
	}
}

console.info(`Generated ${Object.keys(files).length} GQLens files (${changed} changed).`)
