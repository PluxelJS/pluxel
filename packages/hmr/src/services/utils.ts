import fs from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import { normalize, resolve } from 'pathe'

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
