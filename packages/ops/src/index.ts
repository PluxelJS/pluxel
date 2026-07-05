import { tail } from './adapters/cli/tail'
import { OpError, constraint, issue, kindOfOpErrorCode, toOpError } from './types'

export type {
	AnyOperation,
	CliBinding,
	CliAdapterOptions,
	CliHelpCommandResult,
	CliHelpIndexResult,
	CliParamBinding,
	CliToken,
	Infer,
	OpContext,
	OpDescriptor,
	OpDoc,
	OpErr,
	OpErrorCode,
	OpErrorDetails,
	OpErrorKind,
	OpOk,
	OpResult,
	Operation,
	OperationConfig,
	ParamSpec,
	Registration,
	Schema,
	Validator,
	ValidationIssue,
} from './types'

export { defineOp, isOperation } from './define'
export { CliAdapter, createCliAdapter } from './adapters/cli/adapter'
export { createRegistry, OperationRegistry } from './registry'

export const cli = {
	tail,
} as const

export const validation = {
	issue,
	constraint,
} as const

export const errors = {
	OpError,
	kindOfOpErrorCode,
	toOpError,
} as const
