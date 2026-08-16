import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateDtsBundle } from 'dts-bundle-generator'

const docsRoot = fileURLToPath(new URL('..', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const valibotDeclarationPath = join(docsRoot, 'node_modules/valibot/dist/index.d.mts')
const valibotFormEntryPath = join(repositoryRoot, 'packages/valibot-form/src/index.ts')
const outputPath = join(docsRoot, 'public/playground-types.json')
const declarationDirectory = join(docsRoot, 'public/playground-types')

const valibot = await readFile(valibotDeclarationPath, 'utf8')
const [valibotForm] = generateDtsBundle(
	[
		{
			filePath: valibotFormEntryPath,
			libraries: { importedLibraries: ['valibot'] },
			output: { noBanner: true, exportReferencedTypes: false },
		},
	],
	{ preferredConfigPath: join(docsRoot, 'tsconfig.json') },
)

if (!valibotForm) throw new Error('valibot-form declaration generation produced no output')

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `${JSON.stringify({ valibot, valibotForm })}\n`)
await mkdir(declarationDirectory, { recursive: true })
await Promise.all([
	writeFile(join(declarationDirectory, 'valibot.d.ts'), valibot),
	writeFile(join(declarationDirectory, 'valibot-form.d.ts'), valibotForm),
	writeFile(
		join(declarationDirectory, 'globals.d.ts'),
		[
			"declare const v: typeof import('valibot')",
			"declare const f: typeof import('valibot-form')",
		].join('\n'),
	),
])
