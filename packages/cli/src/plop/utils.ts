import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'pathe'

const __dirname = dirname(fileURLToPath(import.meta.url))

export function resolveTemplatesDir(...segments: string[]) {
	if (process.env.NODE_ENV === 'production') {
		// #if NODE_ENV === 'production'
		// 与 dist 同级
		return resolve(__dirname, './plop-templates', ...segments)
		// #endif
	}

	// #if NODE_ENV !== 'production'
	return join(__dirname, '../../plop-templates', ...segments)
	// #endif
}
