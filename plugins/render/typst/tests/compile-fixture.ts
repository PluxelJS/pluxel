import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import runTypst, { type TypstCompileWorkerInput } from '../src/worker.ts'

export function compileFixture(
	input: Omit<TypstCompileWorkerInput, 'templateRoot' | 'inputsRoot'>,
) {
	const workspace = join(input.root, '.workspace')
	const inputsRoot = join(workspace, 'inputs')
	mkdirSync(inputsRoot, { recursive: true })
	return runTypst({ ...input, root: workspace, templateRoot: input.root, inputsRoot })
}
