import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import { dirname } from 'pathe'
import { scaffoldError } from './errors'
import type { ScaffoldPlan } from './plan'

export async function materializeScaffoldPlan(
	plan: ScaffoldPlan,
	log: (...args: unknown[]) => void,
	options: { fs?: typeof fs } = {},
): Promise<void> {
	const fileSystem = options.fs ?? fs
	const overwrite = new Set(plan.overwrite)
	preflightDestination(plan, overwrite, fileSystem)

	fileSystem.mkdirSync(plan.targetDir, { recursive: true })
	const written: string[] = []
	try {
		for (const output of plan.outputs) {
			fileSystem.mkdirSync(dirname(output.absolutePath), { recursive: true })
			const temporaryPath = `${output.absolutePath}.pluxel-${randomUUID()}.tmp`
			try {
				await fileSystem.promises.writeFile(temporaryPath, output.contents)
				await fileSystem.promises.rename(temporaryPath, output.absolutePath)
			} catch (error) {
				await fileSystem.promises.rm(temporaryPath, { force: true }).catch(() => {})
				throw error
			}
			written.push(output.relativePath)
			log(output.existed ? 'overwritten:' : 'created:', output.absolutePath)
		}
	} catch (error) {
		const state = written.length > 0 ? ` Files already written: ${written.join(', ')}.` : ''
		throw scaffoldError(
			'TARGET_CONFLICT',
			`Failed to materialize scaffold at ${plan.targetDir}.${state}`,
			error,
		)
	}
}

export function printScaffoldPlan(plan: ScaffoldPlan, log: (...args: unknown[]) => void) {
	const overwrite = new Set(plan.overwrite)
	log(`\n→ Files to be generated (${plan.outputs.length})`)
	for (const output of plan.outputs) {
		const action = output.existed
			? overwrite.has(output.relativePath)
				? 'overwrite'
				: 'exists'
			: 'create'
		log(`  - [${action}] ${output.relativePath}`)
	}
	if (plan.existing.length > 0 && plan.overwrite.length === 0) {
		log(`\n→ Note: ${plan.existing.length} existing files detected (run requires --force).`)
	}
}

function preflightDestination(
	plan: ScaffoldPlan,
	overwrite: ReadonlySet<string>,
	fileSystem: typeof fs,
) {
	for (const output of plan.outputs) {
		if (!fileSystem.existsSync(output.absolutePath)) continue
		const stats = fileSystem.lstatSync(output.absolutePath)
		if (stats.isSymbolicLink() || !stats.isFile()) {
			throw scaffoldError(
				'TARGET_CONFLICT',
				`Target contains a non-file at output path: ${output.relativePath}`,
			)
		}
		if (!overwrite.has(output.relativePath)) {
			throw scaffoldError(
				'TARGET_CONFLICT',
				`Target contains an existing file: ${output.relativePath}. Use --force to overwrite.`,
			)
		}
	}
}
