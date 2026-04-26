import type { AnyOperation, CliParseboxTailConfig } from '../types'

export type OpRuntime = {
	cli?: {
		parseboxTail?: CliParseboxTailConfig
	}
}

const EMPTY_RUNTIME: OpRuntime = Object.freeze({})
const OP_RUNTIME = Symbol('pluxel.ops.runtime')

type RuntimeBackedOperation = {
	readonly [OP_RUNTIME]?: OpRuntime
}

export const getOperationRuntime = (op: AnyOperation): OpRuntime =>
	(op as RuntimeBackedOperation)[OP_RUNTIME] ?? EMPTY_RUNTIME

export const attachOperationRuntime = <T extends object>(op: T, runtime: OpRuntime): T => {
	Object.defineProperty(op, OP_RUNTIME, {
		value: runtime,
		enumerable: false,
		configurable: false,
		writable: false,
	})
	return op
}
