import { resolve } from 'pathe'
import { runCli } from '@pluxel-internal/pncat/cli'
import { developmentSource } from '../workspace/setup'

/** pncat remains the sole parser and writer for its native commands. */
export async function runPncat(args: string[]): Promise<void> {
	const source = developmentSource()
	await runCli(
		args,
		resolve(
			source.root,
			source.kind === 'git' ? 'packages/cli/dist/pncat-config.mjs' : 'dist/pncat-config.mjs',
		),
		{ configImport: '@pluxel/cli/pncat', command: 'pluxel pncat' },
	)
}
