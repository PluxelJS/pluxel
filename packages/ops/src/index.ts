import { tail } from './adapters/cli/tail'
import { OpError, constraint, issue, kindOfOpErrorCode, toOpError } from './types'

export type {
	AnyOperation,
	CliHelpCommandResult,
	CliHelpIndexResult,
	CliToken,
	CustomValidator,
	Infer,
	OpContext,
	OpDescriptor,
	OpDoc,
	OpExposure,
	OpErr,
	OpErrorCode,
	OpErrorDetails,
	OpErrorKind,
	OpOk,
	OpPolicy,
	OpResult,
	Operation,
	OperationConfig,
	OperationEntry,
	OperationListOptions,
	OperationRegisterOptions,
	OperationSpace,
	OperationSpaceOptions,
	ToolDef,
	ToolListOptions,
	ParamSpec,
	Schema,
	ValidationIssue,
} from './types'

export { defineOp, isOperation } from './define'
export { createSpace } from './space'

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
