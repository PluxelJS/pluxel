import { randomUUID } from 'node:crypto'
import { SourceMap, type SourceMapPayload } from 'node:module'
import { compileFunction } from 'node:vm'
import type { RootContext } from '@pluxel/core'
import { executeHostScript } from './execute'
import { ScriptExecutor } from './runtime'
import { ScriptExecutionError, type ScriptArtifact } from './protocol'
import type { Script } from './sdk-types'

export type NodeScriptOwner = Readonly<{
	instanceId: string
	hostEpoch: string
	executor: ScriptExecutor
	/** Cooperative cancellation and real settlement; does not close the borrowed Host. */
	close(): Promise<void>
}> &
	AsyncDisposable

/** Explicitly grants trusted same-process code execution. vm is a loader, not a sandbox. */
export function createNodeScriptOwner(
	options: Readonly<{
		ctx: RootContext
		/** Omitted identities are generated once for this owner, never recovered across process restarts. */
		instanceId?: string
		hostEpoch?: string
	}>,
): NodeScriptOwner {
	const instanceId = options.instanceId ?? randomUUID()
	const hostEpoch = options.hostEpoch ?? randomUUID()
	const executor = new ScriptExecutor({
		instanceId,
		hostEpoch,
		codeKinds: ['artifact'],
		async execute(input, run) {
			if (input.code.kind !== 'artifact')
				throw new ScriptExecutionError(
					'loading_unavailable',
					'Node script owners load uploaded artifacts',
				)
			run.signal.throwIfAborted()
			run.hostEpoch(hostEpoch)
			const artifact = input.code
			const filename = `pluxel-script-${artifact.sourceHash}.js`
			const sourceMap = readSourceMap(artifact)
			try {
				// Each call creates fresh module locals in the existing realm; no ESM cache entries accumulate.
				const exports: unknown = compileFunction(artifact.code, [], { filename })()
				if (!exports || (typeof exports !== 'object' && typeof exports !== 'function'))
					throw new ScriptExecutionError(
						'artifact_invalid',
						'Script factory must return its module exports',
					)
				const script: unknown = Reflect.get(exports, artifact.exportName)
				if (typeof script !== 'function')
					throw new ScriptExecutionError(
						'export_not_callable',
						`Export ${artifact.exportName} is not a function`,
					)
				return await executeHostScript(
					{ ctx: options.ctx, id: input.runId, input: input.input, script: script as Script },
					run,
				)
			} catch (error) {
				throw mapScriptError(error, filename, sourceMap)
			}
		},
	})
	return Object.freeze({
		instanceId,
		hostEpoch,
		executor,
		close: () => executor.close(),
		[Symbol.asyncDispose]: () => executor.close(),
	})
}

function readSourceMap(artifact: ScriptArtifact): SourceMap | undefined {
	if (artifact.sourceMap === undefined) return undefined
	try {
		const payload = JSON.parse(artifact.sourceMap) as SourceMapPayload
		if (
			!payload ||
			payload.version !== 3 ||
			!Array.isArray(payload.sources) ||
			!payload.sources.every((source) => typeof source === 'string') ||
			!Array.isArray(payload.names) ||
			!payload.names.every((name) => typeof name === 'string') ||
			typeof payload.mappings !== 'string'
		)
			throw new Error('Expected source map version 3')
		return new SourceMap(payload)
	} catch (cause) {
		throw new ScriptExecutionError(
			'artifact_invalid',
			`Script source map is invalid: ${cause instanceof Error ? cause.message : 'invalid map'}`,
		)
	}
}

function mapScriptError(error: unknown, filename: string, sourceMap?: SourceMap): unknown {
	if (!(error instanceof Error) || !sourceMap || typeof error.stack !== 'string') return error
	const position = new RegExp(
		`${filename.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):(\\d+)`,
		'g',
	)
	error.stack = error.stack.replaceAll(position, (original, line: string, column: string) => {
		const origin = sourceMap.findOrigin(Number(line), Number(column))
		return 'fileName' in origin
			? `${origin.fileName}:${origin.lineNumber}:${origin.columnNumber}`
			: original
	})
	return error
}
