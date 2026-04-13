import { tail } from './adapters/cli/tail'
import {
	Type,
	TypeBox,
	compileValidator,
	deriveParamSpecs,
	isObjectSchema,
	obj,
	openObj,
	toJsonSchema,
} from './schema'
import { OpError, constraint, issue, kindOfOpErrorCode, toOpError } from './types'

export type {
	AnyOperation,
	CliHelpCommandResult,
	CliHelpIndexResult,
	CliTailSpec,
	CliToken,
	CustomValidator,
	Infer,
	OpCliConfig,
	OpCliProjection,
	OpContext,
	OpDescriptor,
	OpDoc,
	OpExposure,
	OpPublicCliProjection,
	OpPublicDescriptor,
	OpPublicTransports,
	OpErr,
	OpErrorCode,
	OpErrorDetails,
	OpErrorKind,
	OpInterceptor,
	OpOk,
	OpPolicy,
	OpResult,
	OpToolConfig,
	OpSchemas,
	OpTransports,
	Operation,
	OperationConfig,
	OperationSpace,
	ToolDef,
	ParamSpec,
	PublicCliTailSpec,
	Schema,
	ValidationIssue,
} from './types'
export type { Static, TAnySchema, TProperties, TSchema } from './schema'

export { defineOp, isOperation } from './define'
export { createSpace, OpsSpace } from './space'
export { toPublicDescriptor } from './types'

export const typebox = {
	Type,
	TypeBox,
	obj,
	openObj,
	compileValidator,
	deriveParamSpecs,
	isObjectSchema,
	toJsonSchema,
} as const

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
