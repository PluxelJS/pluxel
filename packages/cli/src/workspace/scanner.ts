import { dirname, relative, resolve } from 'pathe'
import { fdir } from 'fdir'

const IGNORED = ['node_modules', '.git', '.turbo', '.output', '.next', '.nuxt', '.cache']

export async function scanWorkspaceDirs(root: string, base?: string) {
	const target = base ? resolve(root, base) : root
	const files = await new fdir()
		.withFullPaths()
		.exclude((name) => IGNORED.includes(name))
		.filter((path, isDirectory) => (isDirectory ? true : path.endsWith('package.json')))
		.crawl(target)
		.withPromise()
	return dedupe(
		files
			.map((file) => relative(root, dirname(file)).replace(/\\/g, '/'))
			.filter((path) => path && !path.includes('node_modules')),
	)
}

function dedupe(list: string[]) {
	return [...new Set(list)].sort((a, b) => a.localeCompare(b))
}
