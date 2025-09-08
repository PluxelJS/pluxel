import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'pathe'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function resolveTemplatesDir(...segments: string[]) {
	if (import.meta.env.PROD) {
		// 与 dist 同级
		return resolve(__dirname, './plop-templates', ...segments)
	}
	return join(__dirname, '../../plop-templates', ...segments)
}
