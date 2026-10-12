import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateDtsBundle } from 'dts-bundle-generator'

const root = fileURLToPath(new URL('..', import.meta.url))
export async function generateEditorTypes() {
	const output = join(root, '.editor-generated')
	const types = join(output, 'public', 'types')
	const valibot = await readFile(join(root, 'node_modules/valibot/dist/index.d.mts'), 'utf8')
	const [valibotForm, typstTemplate] = generateDtsBundle(
		[
			{
				filePath: join(root, '../../packages/valibot-form/src/index.ts'),
				libraries: { importedLibraries: ['valibot'] },
				output: { noBanner: true, exportReferencedTypes: false },
			},
			{
				filePath: join(root, '../../plugins/render/typst/src/template.ts'),
				libraries: { importedLibraries: ['valibot'] },
				output: { noBanner: true, exportReferencedTypes: false },
			},
		],
		{ preferredConfigPath: join(root, 'tsconfig.json') },
	)
	if (!valibotForm) throw new Error('valibot-form declaration generation produced no output')
	if (!typstTemplate) throw new Error('Typst document declaration generation produced no output')
	await mkdir(types, { recursive: true })
	await Promise.all([
		writeFile(join(types, 'valibot.d.ts'), valibot),
		writeFile(join(types, 'typst-template.d.ts'), typstTemplate),
		writeFile(join(types, 'valibot-form.d.ts'), valibotForm),
		copyFile(
			join(root, 'node_modules/tm-grammars/grammars/typst.json'),
			join(output, 'typst.json'),
		),
		copyFile(
			join(root, 'node_modules/tm-themes/themes/vitesse-light.json'),
			join(output, 'vitesse-light.json'),
		),
	])
}
if (process.argv[1] && dirname(fileURLToPath(import.meta.url)) === dirname(process.argv[1]))
	await generateEditorTypes()
