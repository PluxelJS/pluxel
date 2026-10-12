import { execFileSync } from 'node:child_process'

/** Use the invoking CLI directly: Windows .cmd shims need no shell or quoting. */
export function runPnpm(args, options) {
	const cli = process.env.npm_execpath
	if (!cli) throw new Error('Run this command through the Studio pnpm script')
	const script = /\.(?:cjs|mjs|js)$/i.test(cli)
	return execFileSync(script ? process.execPath : cli, script ? [cli, ...args] : args, options)
}
