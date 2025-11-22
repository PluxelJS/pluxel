import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'pathe'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function resolveTemplatesDir(...segments: string[]) {
	if (import.meta.env.BUILD) {
		return join(__dirname, '../../plop-templates', ...segments)
	}
	return resolve(__dirname, './plop-templates', ...segments)
}
