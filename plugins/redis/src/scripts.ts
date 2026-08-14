import { createHash } from 'node:crypto'
import type { RedisArgument } from 'redis'

declare const REDIS_SCRIPT_TYPES: unique symbol

export interface RedisScriptCall<
	Keys extends readonly RedisArgument[] = readonly RedisArgument[],
	Arguments extends readonly RedisArgument[] = readonly RedisArgument[],
> {
	keys: Keys
	arguments?: Arguments
}

export interface RedisScriptDefinition<
	Keys extends readonly RedisArgument[] = readonly RedisArgument[],
	Arguments extends readonly RedisArgument[] = readonly RedisArgument[],
	Result = unknown,
> {
	readonly name: string
	readonly source: string
	readonly sha1: string
	readonly numberOfKeys?: number
	readonly readOnly: boolean
	readonly decode: (reply: unknown) => Result
	readonly [REDIS_SCRIPT_TYPES]?: { keys: Keys; arguments: Arguments }
}

export interface DefineRedisScriptOptions<Result> {
	name: string
	source: string
	numberOfKeys?: number
	readOnly?: boolean
	decode: (reply: unknown) => Result
}

export type DefineRawRedisScriptOptions = Omit<DefineRedisScriptOptions<unknown>, 'decode'> & {
	decode?: undefined
}

export type RedisScriptRunner<
	Keys extends readonly RedisArgument[] = readonly RedisArgument[],
	Arguments extends readonly RedisArgument[] = readonly RedisArgument[],
	Result = unknown,
> = (call: RedisScriptCall<Keys, Arguments>) => Promise<Result>

export class RedisScriptDecodeError extends Error {
	override name = 'RedisScriptDecodeError'

	constructor(scriptName: string, cause: unknown) {
		super(`Redis script "${scriptName}" returned an invalid reply.`, { cause })
	}
}

export function defineRedisScript<
	Keys extends readonly RedisArgument[] = readonly RedisArgument[],
	Arguments extends readonly RedisArgument[] = readonly RedisArgument[],
	Result = unknown,
>(options: DefineRedisScriptOptions<Result>): RedisScriptDefinition<Keys, Arguments, Result>
export function defineRedisScript<
	Keys extends readonly RedisArgument[] = readonly RedisArgument[],
	Arguments extends readonly RedisArgument[] = readonly RedisArgument[],
>(options: DefineRawRedisScriptOptions): RedisScriptDefinition<Keys, Arguments, unknown>
export function defineRedisScript(
	options: DefineRedisScriptOptions<unknown> | DefineRawRedisScriptOptions,
): RedisScriptDefinition {
	const name = options.name.trim()
	if (!name) throw new TypeError('Redis script name must not be empty.')
	if (!options.source.trim())
		throw new TypeError(`Redis script "${name}" source must not be empty.`)
	if (
		options.numberOfKeys !== undefined &&
		(!Number.isSafeInteger(options.numberOfKeys) || options.numberOfKeys < 0)
	) {
		throw new RangeError(`Redis script "${name}" numberOfKeys must be a non-negative integer.`)
	}
	const source = options.source
	return Object.freeze({
		name,
		source,
		sha1: createHash('sha1').update(source).digest('hex'),
		numberOfKeys: options.numberOfKeys,
		readOnly: options.readOnly ?? false,
		decode: options.decode ?? ((reply: unknown) => reply),
	})
}

type ScriptingClient = {
	evalSha(sha1: string, options: ScriptCommandOptions): Promise<unknown>
	eval(source: string, options: ScriptCommandOptions): Promise<unknown>
	evalShaRo(sha1: string, options: ScriptCommandOptions): Promise<unknown>
	evalRo(source: string, options: ScriptCommandOptions): Promise<unknown>
}

type ScriptCommandOptions = {
	keys: RedisArgument[]
	arguments: RedisArgument[]
}

export class RedisScripts {
	private readonly runners = new WeakMap<object, RedisScriptRunner>()

	constructor(private readonly getClient: () => unknown) {}

	use<Keys extends readonly RedisArgument[], Arguments extends readonly RedisArgument[], Result>(
		definition: RedisScriptDefinition<Keys, Arguments, Result>,
	): RedisScriptRunner<Keys, Arguments, Result> {
		const existing = this.runners.get(definition)
		if (existing) return existing as RedisScriptRunner<Keys, Arguments, Result>
		const runner: RedisScriptRunner<Keys, Arguments, Result> = (call) => this.run(definition, call)
		this.runners.set(definition, runner as RedisScriptRunner)
		return runner
	}

	async run<
		Keys extends readonly RedisArgument[],
		Arguments extends readonly RedisArgument[],
		Result,
	>(
		definition: RedisScriptDefinition<Keys, Arguments, Result>,
		call: RedisScriptCall<Keys, Arguments>,
	): Promise<Result> {
		const keys = [...call.keys]
		if (definition.numberOfKeys !== undefined && keys.length !== definition.numberOfKeys) {
			throw new RangeError(
				`Redis script "${definition.name}" requires ${definition.numberOfKeys} keys; received ${keys.length}.`,
			)
		}
		const options: ScriptCommandOptions = {
			keys,
			arguments: call.arguments ? [...call.arguments] : [],
		}
		const client = this.getClient() as ScriptingClient
		let reply: unknown
		try {
			reply = definition.readOnly
				? await client.evalShaRo(definition.sha1, options)
				: await client.evalSha(definition.sha1, options)
		} catch (error) {
			if (!isNoScriptError(error)) throw error
			reply = definition.readOnly
				? await client.evalRo(definition.source, options)
				: await client.eval(definition.source, options)
		}
		try {
			return definition.decode(reply)
		} catch (error) {
			throw new RedisScriptDecodeError(definition.name, error)
		}
	}
}

function isNoScriptError(error: unknown): boolean {
	return error instanceof Error && error.message.startsWith('NOSCRIPT')
}
