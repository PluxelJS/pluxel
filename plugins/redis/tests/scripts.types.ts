import { defineRedisScript, type RedisScriptCall, type RedisScripts } from '../src/scripts.ts'

const Add = defineRedisScript<readonly [string], readonly [string], number>({
	name: 'add',
	source: "return redis.call('INCRBY', KEYS[1], ARGV[1])",
	decode: Number,
})
function calls(scripts: RedisScripts) {
	const result: Promise<number> = scripts.run(Add, { keys: ['counter'], arguments: ['1'] })
	const run = scripts.use(Add)
	// @ts-expect-error A script with required ARGV must receive arguments.
	scripts.run(Add, { keys: ['counter'] })
	// @ts-expect-error Cached runners preserve required ARGV.
	run({ keys: ['counter'] })
	// @ts-expect-error Required tuple cannot be empty.
	run({ keys: ['counter'], arguments: [] })
	// @ts-expect-error ARGV element type is preserved.
	run({ keys: ['counter'], arguments: [1] })
	return result
}
const empty: RedisScriptCall<readonly [string], readonly []> = { keys: ['key'] }
const optional: RedisScriptCall<readonly [], readonly [] | readonly [string]> = { keys: [] }
const open: RedisScriptCall = { keys: [] }
void [calls, empty, optional, open]
