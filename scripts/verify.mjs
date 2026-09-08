import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Local verification and CI share the same gates. Arguments only customize Turbo's
// execution (for example concurrency, affected packages, and run summaries).
const turboArgs = process.argv.slice(2)
if (!turboArgs.some((arg) => arg === '--concurrency' || arg.startsWith('--concurrency='))) {
	turboArgs.unshift('--concurrency=50%')
}
const steps = [
	['run', 'governance:check'],
	['run', 'lint'],
	['run', 'format:check'],
	['exec', 'turbo', 'run', 'typecheck', 'build', 'test', ...turboArgs],
	['run', 'source-declarations:check'],
]

for (const args of steps) {
	console.log(`\n${process.env.GITHUB_ACTIONS ? '::group::' : ''}pnpm ${args.join(' ')}`)
	const result = spawnSync('pnpm', args, {
		cwd: fileURLToPath(new URL('..', import.meta.url)),
		stdio: 'inherit',
	})
	if (process.env.GITHUB_ACTIONS) console.log('::endgroup::')
	if (result.error) console.error(result.error.message)
	if (result.status !== 0) {
		process.exit(result.status ?? 1)
	}
}
