import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function checkWorksplitNative(consumer) {
	const root = resolve(consumer)
	const require = createRequire(join(root, 'package.json'))
	const installer = require.resolve('@worksplit/react/native-dependencies/install.mjs')
	execFileSync(process.execPath, [installer, '--check', root], { stdio: 'inherit' })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	for (const consumer of process.argv.slice(2)) checkWorksplitNative(consumer)
}
