import { readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const sourceRoots = ['packages', 'plugins', 'projects']
const ignoredDirectories = new Set(['.git', '.pluxel', '.vercel', 'dist', 'node_modules', 'public'])
const declarationPattern = /\.d\.[cm]?ts$/
const declarationMapPattern = /\.d\.[cm]?ts\.map$/
// Handwritten ambient declarations and module augmentations are source inputs.
// Register them explicitly; a tracked file or a declaration-looking name alone
// must never exempt generated compiler output from this check.
const allowedDeclarations = new Set([
	'packages/runtime-dynamic/src/third-party.d.ts',
	'packages/test/src/vendor-types.d.ts',
	'packages/valibot-form/src/web/vite-env.d.ts',
	'packages/workbench-app/src/theme/mantine/mantine.d.ts',
	'packages/workbench-app/src/types/worksplit-react.d.ts',
	'packages/workbench-app/src/vite-env.d.ts',
	'projects/docs/src/styles.d.ts',
])

const declarationGroups = await Promise.all(
	sourceRoots.map((directory) => declarationFiles(resolve(root, directory), false)),
)
const declarations = declarationGroups.flat()
const unexpected = declarations
	.map((path) => relative(root, path).replaceAll('\\', '/'))
	.filter((path) => declarationMapPattern.test(path) || !allowedDeclarations.has(path))
	.toSorted()

if (unexpected.length > 0) {
	process.stderr.write(
		`Unexpected declarations in source directories:\n- ${unexpected.join('\n- ')}\n` +
			'Declaration builds must keep intermediate output in dist or a disposable cache.\n' +
			'Load external environment types through tsconfig types; register handwritten ambient declarations explicitly.\n',
	)
	process.exitCode = 1
} else {
	process.stdout.write(
		`Source declaration check passed (${declarations.length} explicit declarations found)\n`,
	)
}

async function declarationFiles(directory, insideSource) {
	let entries
	try {
		entries = await readdir(directory, { withFileTypes: true })
	} catch (error) {
		if (error?.code === 'ENOENT') {
			return []
		}
		throw error
	}

	const nested = await Promise.all(
		entries.map((entry) => {
			const path = resolve(directory, entry.name)
			if (entry.isDirectory()) {
				if (ignoredDirectories.has(entry.name)) {
					return []
				}
				return declarationFiles(path, insideSource || entry.name === 'src')
			}
			return declarationMapPattern.test(entry.name) ||
				(insideSource && declarationPattern.test(entry.name))
				? [path]
				: []
		}),
	)
	return nested.flat()
}
