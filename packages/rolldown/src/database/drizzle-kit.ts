import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'pathe'

export type DrizzleKitPlan = Readonly<{ root: string; schema: string; out: string }>

export async function runDrizzleKit(
	command: 'generate' | 'check',
	plan: DrizzleKitPlan,
	extra: readonly string[] = [],
): Promise<void> {
	const require = createRequire(import.meta.url)
	let binary: string
	try {
		binary = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs')
	} catch (error) {
		throw new Error(
			'[database] migration tooling requires drizzle-kit; install a compatible @pluxel/rolldown package',
			{ cause: error },
		)
	}
	const args =
		command === 'generate'
			? [
					binary,
					command,
					'--dialect',
					'postgresql',
					'--schema',
					relative(plan.root, plan.schema),
					'--out',
					relative(plan.root, plan.out),
					...extra,
				]
			: [
					binary,
					command,
					'--dialect',
					'postgresql',
					'--out',
					relative(plan.root, plan.out),
					...extra,
				]
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(process.execPath, args, { cwd: plan.root, stdio: 'inherit' })
		child.once('error', reject)
		child.once('exit', (code, signal) => {
			if (code === 0) resolvePromise()
			else reject(new Error(`[database] drizzle-kit ${command} failed (${signal ?? code})`))
		})
	})
}
