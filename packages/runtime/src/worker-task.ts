import { createNodeModuleDeclaration } from './node-module'

declare const workerTaskBrand: unique symbol

/** A separately-built Node worker entry whose default export handles one cloneable input value. */
export type WorkerTaskDeclaration<Input = unknown, Output = unknown> = Readonly<{
	[workerTaskBrand]: (input: Input) => Output
}>

/** The default export contract implemented by a declared worker entry. */
export type WorkerTaskHandler<Input, Output> = (input: Input) => Output | Promise<Output>

/** Declare a module-level worker task for `ctx.workers.run()`. */
export function defineWorkerTask<Input, Output>(
	moduleUrl: string | URL,
	entryPath: string,
): WorkerTaskDeclaration<Input, Output> {
	return createNodeModuleDeclaration(
		moduleUrl,
		entryPath,
		arguments[2],
		'defineWorkerTask',
	) as unknown as WorkerTaskDeclaration<Input, Output>
}
