import fs from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import { normalize, resolve } from 'pathe'
import { resolvePath } from 'mlly'

const entryCache = new Map<string, Promise<string>>()

export function scanPackageEntryByPath(
	path: string,
	isDev: boolean,
): Promise<string> {
	const key = `${path}::${isDev}`
	if (!entryCache.has(key)) {
		entryCache.set(
			key,
			resolvePath(path, { conditions: isDev ? ['@pluxel/source'] : undefined }),
		)
	}
	return entryCache.get(key)!
}

export async function getAllTsFiles(dirs: string[]): Promise<string[]> {
	const results: string[] = []

	// 递归遍历函数
	async function walk(dir: string) {
		// fs.opendir 返回一个 AsyncIterable<Dirent>
		const handle = await fs.opendir(dir)
		for await (const dirent of handle) {
			const fullPath = join(dir, dirent.name)
			if (dirent.isDirectory()) {
				await walk(fullPath)
			} else if (dirent.isFile() && extname(dirent.name) === '.ts') {
				results.push(fullPath)
			}
		}
	}

	// 先把传入的目录都转成绝对路径
	for (const dir of dirs) {
		const absDir = isAbsolute(dir) ? dir : resolve(process.cwd(), dir)
		await walk(absDir)
	}

	return results.map((res) => normalize(res))
}
