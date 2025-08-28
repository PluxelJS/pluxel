import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'pathe'
export function kebabCase(s: string) {
	return s
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

const __dirname = dirname(fileURLToPath(import.meta.url))

export function resolveTemplatesDir(...segments: string[]) {
	if (import.meta.env.PROD) {
		// 与 dist 同级
		return resolve(__dirname, './plop-templates', ...segments)
	}
	return join(__dirname, '../../plop-templates', ...segments)
}
