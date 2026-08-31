import { mkdir, readFile, writeFile } from 'node:fs/promises'
import Module from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// dts-bundle-generator still uses the pre-TypeScript-7 compiler API through CommonJS.
// Keep the application compiler on TS 7 while routing this isolated tool to the legacy alias.
const CommonJsModule = /** @type {typeof Module & {
 * _load(request: string, parent: unknown, isMain: boolean): unknown
 * }} */ (Module)
const loadCommonJsModule = CommonJsModule._load
CommonJsModule._load = function loadWithLegacyTypeScript(request, parent, isMain) {
	return loadCommonJsModule(
		request === 'typescript' ? 'typescript-legacy' : request,
		parent,
		isMain,
	)
}
const { generateDtsBundle } = await import('dts-bundle-generator')
CommonJsModule._load = loadCommonJsModule

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
