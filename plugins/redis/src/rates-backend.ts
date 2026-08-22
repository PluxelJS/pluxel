import { createHash } from 'node:crypto'
import {
	RatesBackend,
	type RatesBackendConsumeRequest,
	type RateDecision,
	type ResolvedRatePolicy,
	RatesPolicyConflictError,
} from '@pluxel/rates'
import { formatPluginNodeReference, Plugin, type PluginNodeAddress, v } from '@pluxel/runtime'
import { Redis } from './client.ts'
import { defineRedisScript, type RedisScriptDefinition, type RedisScriptRunner } from './scripts.ts'
import { isWellFormedUnicode } from './validation.ts'

type RedisRatesReply =
	| { kind: 'decision'; decision: RateDecision }
	| { kind: 'conflict'; active: Readonly<ResolvedRatePolicy> }

const LUA_COMMON = String.raw`
local MAX_SAFE = 9007199254740991
local MAX_WINDOW = 2147483647
local MAX_STATE_TTL = 4294967294
local MAX_TIMESTAMP = MAX_SAFE - MAX_STATE_TTL
local function integer(value)
  local number = tonumber(value)
  if not number or number < 0 or number > MAX_SAFE or math.floor(number) ~= number then return nil end
  return number
end
local function positive(value)
  local number = integer(value)
  if not number or number < 1 then return nil end
  return number
end
local function timestamp(value)
  local number = integer(value)
  if not number or number > MAX_TIMESTAMP then return nil end
  return number
end
local function safe_product(left, right)
  local product = left * right
  if product > MAX_SAFE or math.floor(product) ~= product then return nil end
  return product
end
local function now_ms()
  local clock = redis.call('TIME')
  return tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
end
local function conflict(algorithm, limit, window, burst)
  return {-1, algorithm, limit, window, burst or 0}
end
local function parse_log_meta(member)
  if not member then return nil end
  local version, algorithm, limit, window, used, observed, lastAt, sequence, owner = string.match(
    member, '^m|([^|]+)|([^|]+)|([^|]+)|([^|]+)|([^|]+)|([^|]+)|([^|]+)|([^|]+)|(.*)$'
  )
  version = integer(version); limit = positive(limit); window = positive(window); used = positive(used)
  observed = timestamp(observed); lastAt = timestamp(lastAt); sequence = integer(sequence)
  if version ~= 2 or algorithm ~= 'sliding-window-log' or not limit or limit > 10000 or
     not window or window > MAX_WINDOW or not used or used > limit or not observed or
     not lastAt or lastAt > observed or not sequence or sequence > 10000 or not owner or owner == '' or
     lastAt + window > MAX_SAFE or lastAt + window <= observed then return nil end
  return {algorithm=algorithm, limit=limit, window=window, used=used, observed=observed, lastAt=lastAt, sequence=sequence, owner=owner}
end
local function parse_log_event(member, score)
  local at, sequence, cost = string.match(member, '^e|([^|]+)|([^|]+)|([^|]+)$')
  at = timestamp(at); sequence = integer(sequence); cost = positive(cost); score = integer(score)
  if not at or not sequence or sequence > 10000 or not cost or not score or score ~= at then return nil end
  return {member=member, at=at, sequence=sequence, cost=cost}
end
local function read_log_header(key)
  local metas = redis.call('ZRANGEBYSCORE', key, -1, -1)
  if #metas ~= 1 then return nil end
  local metaMember = metas[1]
  local meta = parse_log_meta(metaMember)
  if not meta then return nil end
  local eventCount = redis.call('ZCARD', key) - 1
  if eventCount < 1 or eventCount > meta.used then return nil end
  local firstRaw = redis.call('ZRANGE', key, 1, 1, 'WITHSCORES')
  local lastRaw = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
  if #firstRaw ~= 2 or #lastRaw ~= 2 then return nil end
  local first = parse_log_event(firstRaw[1], firstRaw[2])
  local last = parse_log_event(lastRaw[1], lastRaw[2])
  if not first or not last or first.sequence ~= 0 or first.at > last.at or
     first.at + meta.window <= meta.observed or last.at ~= meta.lastAt or
     redis.call('ZCOUNT', key, meta.lastAt, meta.lastAt) ~= meta.sequence + 1 then return nil end
  return {meta=meta, metaMember=metaMember, eventCount=eventCount}
end
local function read_hash_state(key)
  local common = redis.call('HMGET', key, 'version', 'algorithm', 'limit', 'window', 'burst', 'observedAt', 'owner')
  local version = integer(common[1]); local algorithm = common[2]
  local limit = positive(common[3]); local window = positive(common[4]); local burst = integer(common[5])
  local observed = timestamp(common[6]); local owner = common[7]
  if version ~= 2 or not algorithm or not limit or not window or window > MAX_WINDOW or
     not burst or not observed or not owner or owner == '' then return nil end
  if algorithm == 'token-bucket' then
    if redis.call('HLEN', key) ~= 9 or burst < 1 then return nil end
    local capacity = safe_product(burst, window)
    local refillTtl = capacity and math.ceil(capacity / limit) or nil
    local values = redis.call('HMGET', key, 'balance', 'updatedAt')
    local balance = integer(values[1]); local updatedAt = timestamp(values[2])
    if not capacity or not refillTtl or refillTtl > MAX_STATE_TTL or not balance or
       balance >= capacity or updatedAt ~= observed then return nil end
    return {algorithm=algorithm, limit=limit, window=window, burst=burst, observed=observed, owner=owner,
      capacity=capacity, balance=balance, updatedAt=updatedAt}
  end
  if burst ~= 0 then return nil end
  if algorithm == 'fixed-window' then
    if redis.call('HLEN', key) ~= 9 then return nil end
    local values = redis.call('HMGET', key, 'windowStart', 'used')
    local start = timestamp(values[1]); local used = integer(values[2])
    if not start or start ~= math.floor(observed / window) * window or not used or used < 1 or
       used > limit or start + window <= observed then return nil end
    return {algorithm=algorithm, limit=limit, window=window, burst=0, observed=observed, owner=owner, start=start, used=used}
  end
  if algorithm == 'sliding-window-counter' then
    if redis.call('HLEN', key) ~= 10 then return nil end
    local capacity = safe_product(limit, window)
    local values = redis.call('HMGET', key, 'windowStart', 'previous', 'current')
    local start = timestamp(values[1]); local previous = integer(values[2]); local current = integer(values[3])
    if not capacity or not start or start ~= math.floor(observed / window) * window or not previous or
       not current or previous > limit or current > limit or previous + current < 1 then return nil end
    local elapsed = observed - start
    local usedUnits = current * window + previous * (window - elapsed)
    local resetAt = current > 0 and start + 2 * window or start + window
    if usedUnits > capacity or resetAt <= observed then return nil end
    return {algorithm=algorithm, limit=limit, window=window, burst=0, observed=observed, owner=owner,
      start=start, previous=previous, current=current}
  end
  return nil
end
local function existing_hash_or_conflict(key, requestedAlgorithm, requestedLimit, requestedWindow, requestedBurst, requestedOwner)
  local kind = redis.call('TYPE', key).ok
  if kind == 'none' then return nil end
  if kind == 'zset' then
    local state = read_log_header(key)
    if not state then return {-2} end
    if state.meta.owner ~= requestedOwner then return {-2} end
    return conflict(state.meta.algorithm, state.meta.limit, state.meta.window, 0)
  end
  if kind ~= 'hash' then return {-2} end
  local state = read_hash_state(key)
  if not state then return {-2} end
  if state.owner ~= requestedOwner then return {-2} end
  if state.algorithm ~= requestedAlgorithm or state.limit ~= requestedLimit or
     state.window ~= requestedWindow or state.burst ~= requestedBurst then
    return conflict(state.algorithm, state.limit, state.window, state.burst)
  end
  return state
end
`

const ConsumeTokenBucket = script(
	'token-bucket',
	String.raw`
local limit = positive(ARGV[1]); local window = positive(ARGV[2]); local burst = positive(ARGV[3]); local owner = ARGV[4]; local cost = positive(ARGV[5])
local requestedCapacity = limit and window and burst and safe_product(burst, window) or nil
if not limit or not window or window > MAX_WINDOW or not burst or not cost or cost > burst or
   not owner or owner == '' or not requestedCapacity or math.ceil(requestedCapacity / limit) > MAX_STATE_TTL then return {-2} end
local existing = existing_hash_or_conflict(KEYS[1], 'token-bucket', limit, window, burst, owner)
if existing and existing[1] then return existing end
local now = now_ms(); local capacity = requestedCapacity; local balance; local updatedAt
if existing then
  balance = existing.balance; updatedAt = existing.updatedAt
  if now < existing.observed then now = existing.observed end
  if now < updatedAt then now = updatedAt end
  local missing = capacity - balance
  local elapsed = now - updatedAt
  if missing > 0 then
    if elapsed >= math.ceil(missing / limit) then balance = capacity else balance = balance + elapsed * limit end
  end
else
  balance = capacity; updatedAt = now
end
local costUnits = cost * window; local allowed = 0
if balance >= costUnits then allowed = 1; balance = balance - costUnits end
local untilFull = math.ceil((capacity - balance) / limit)
local remaining = math.floor(balance / window)
redis.call('HSET', KEYS[1], 'version', 2, 'algorithm', 'token-bucket', 'limit', limit, 'window', window,
  'burst', burst, 'observedAt', now, 'owner', owner, 'balance', balance, 'updatedAt', now)
redis.call('PEXPIRE', KEYS[1], math.max(1, untilFull))
if allowed == 1 then return {1, remaining, now + untilFull} end
return {0, remaining, math.max(1, math.ceil((costUnits - balance) / limit)), now + untilFull}
`,
)

const ConsumeFixedWindow = script(
	'fixed-window',
	String.raw`
local limit = positive(ARGV[1]); local window = positive(ARGV[2]); local owner = ARGV[4]; local cost = positive(ARGV[5])
if not limit or not window or window > MAX_WINDOW or not owner or owner == '' or not cost or cost > limit then return {-2} end
local existing = existing_hash_or_conflict(KEYS[1], 'fixed-window', limit, window, 0, owner)
if existing and existing[1] then return existing end
local now = now_ms(); if existing and now < existing.observed then now = existing.observed end
local start = math.floor(now / window) * window; local used = 0
if existing then
  local oldStart = existing.start; used = existing.used
  if oldStart ~= start then used = 0 end
end
local allowed = 0; if cost <= limit - used then allowed = 1; used = used + cost end
local resetAt = start + window; local remaining = limit - used
redis.call('HSET', KEYS[1], 'version', 2, 'algorithm', 'fixed-window', 'limit', limit, 'window', window,
  'burst', 0, 'observedAt', now, 'owner', owner, 'windowStart', start, 'used', used)
redis.call('PEXPIRE', KEYS[1], math.max(1, resetAt - now))
if allowed == 1 then return {1, remaining, resetAt} end
return {0, remaining, math.max(1, resetAt - now), resetAt}
`,
)

const ConsumeSlidingCounter = script(
	'sliding-window-counter',
	String.raw`
local limit = positive(ARGV[1]); local window = positive(ARGV[2]); local owner = ARGV[4]; local cost = positive(ARGV[5])
local requestedCapacity = limit and window and safe_product(limit, window) or nil
if not limit or not window or window > MAX_WINDOW or not owner or owner == '' or not cost or cost > limit or not requestedCapacity then return {-2} end
local existing = existing_hash_or_conflict(KEYS[1], 'sliding-window-counter', limit, window, 0, owner)
if existing and existing[1] then return existing end
local now = now_ms(); if existing and now < existing.observed then now = existing.observed end
local targetStart = math.floor(now / window) * window; local start = targetStart; local previous = 0; local current = 0
if existing then
  start = existing.start; previous = existing.previous; current = existing.current
  local windows = math.floor((targetStart - start) / window)
  if windows == 1 then previous = current; current = 0; start = targetStart
  elseif windows >= 2 then previous = 0; current = 0; start = targetStart end
end
local elapsed = now - start
local usedUnits = current * window + previous * (window - elapsed)
local capacity = requestedCapacity; local costUnits = cost * window; local allowed = 0
if costUnits <= capacity - usedUnits then allowed = 1; current = current + cost; usedUnits = usedUnits + costUnits end
local remaining = math.floor((capacity - usedUnits) / window)
local resetAt = now
if current > 0 then resetAt = start + 2 * window elseif previous > 0 then resetAt = start + window end
redis.call('HSET', KEYS[1], 'version', 2, 'algorithm', 'sliding-window-counter', 'limit', limit, 'window', window,
  'burst', 0, 'observedAt', now, 'owner', owner, 'windowStart', start, 'previous', previous, 'current', current)
redis.call('PEXPIRE', KEYS[1], math.max(1, resetAt - now))
if allowed == 1 then return {1, remaining, resetAt} end
local boundary = start + window
local deficit = costUnits - (capacity - usedUnits)
local retry
if previous > 0 then
  retry = math.max(1, math.ceil(deficit / previous))
  if now + retry > boundary then retry = nil end
end
local atBoundary = current * window
if not retry then
  if costUnits <= capacity - atBoundary then retry = math.max(1, boundary - now)
  else retry = math.max(1, boundary - now + math.ceil((costUnits - (capacity - atBoundary)) / current)) end
end
return {0, remaining, retry, resetAt}
`,
)

const ConsumeSlidingLog = defineRedisScript<
	readonly [string],
	readonly [string, string, string, string, string],
	RedisRatesReply
>({
	name: 'pluxel.rates.consume-sliding-window-log-v2',
	numberOfKeys: 1,
	source: `${LUA_COMMON}\n${String.raw`
local function log_meta_member(meta, observed)
  return 'm|2|sliding-window-log|' .. meta.limit .. '|' .. meta.window .. '|' .. meta.used .. '|' ..
    observed .. '|' .. meta.lastAt .. '|' .. meta.sequence .. '|' .. meta.owner
end
local limit = positive(ARGV[1]); local window = positive(ARGV[2]); local owner = ARGV[4]; local cost = positive(ARGV[5])
if not limit or limit > 10000 or not window or window > MAX_WINDOW or not owner or owner == '' or not cost or cost > limit then return {-2} end
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'hash' then
  local active = read_hash_state(KEYS[1])
  if not active then return {-2} end
  if active.owner ~= owner then return {-2} end
  return conflict(active.algorithm, active.limit, active.window, active.burst)
elseif kind ~= 'none' and kind ~= 'zset' then return {-2} end
local now = now_ms(); local metaMember; local meta; local eventCount = 0
local expiredCount = 0; local releasedExpired = 0; local deleteExisting = false
if kind == 'zset' then
  local state = read_log_header(KEYS[1])
  if not state then return {-2} end
  metaMember = state.metaMember; meta = state.meta; eventCount = state.eventCount
  if meta.owner ~= owner then return {-2} end
  if now < meta.observed then now = meta.observed end
  local cutoff = now - meta.window
  if meta.lastAt <= cutoff then
    deleteExisting = true; meta = nil; eventCount = 0
  else
    local rawExpired = redis.call('ZRANGEBYSCORE', KEYS[1], 0, cutoff, 'WITHSCORES')
    local previousAt = nil; local sequenceCounts = {}; local sequenceMax = {}
    for index = 1, #rawExpired, 2 do
      local event = parse_log_event(rawExpired[index], rawExpired[index + 1])
      if not event or event.at > state.meta.observed or (previousAt and event.at < previousAt) then return {-2} end
      releasedExpired = releasedExpired + event.cost
      if releasedExpired >= state.meta.used then return {-2} end
      expiredCount = expiredCount + 1; previousAt = event.at
      sequenceCounts[event.at] = (sequenceCounts[event.at] or 0) + 1
      sequenceMax[event.at] = math.max(sequenceMax[event.at] or -1, event.sequence)
    end
    for at, count in pairs(sequenceCounts) do
      if count ~= sequenceMax[at] + 1 then return {-2} end
    end
    if expiredCount >= eventCount then return {-2} end
    eventCount = eventCount - expiredCount; meta.used = meta.used - releasedExpired
    if meta.used < eventCount then return {-2} end
  end
end
if meta and (meta.limit ~= limit or meta.window ~= window) then
  local activeMeta = log_meta_member(meta, now)
  if expiredCount > 0 and redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - meta.window) ~= expiredCount then return {-2} end
  redis.call('ZREM', KEYS[1], metaMember)
  redis.call('ZADD', KEYS[1], -1, activeMeta)
  redis.call('PEXPIRE', KEYS[1], math.max(1, meta.lastAt + meta.window - now))
  return conflict(meta.algorithm, meta.limit, meta.window, 0)
end
if not meta then meta = {limit=limit, window=window, used=0, observed=now, lastAt=0, sequence=0, owner=owner} end
local allowed = 0
if cost <= limit - meta.used then
  allowed = 1
  if meta.lastAt == now then meta.sequence = meta.sequence + 1 else meta.lastAt = now; meta.sequence = 0 end
  if meta.sequence > 10000 then return {-2} end
  meta.used = meta.used + cost
end
local resetAt = meta.lastAt + window; local remaining = limit - meta.used
local retryAt = nil
if allowed == 0 then
  local deficit = cost - (limit - meta.used); local released = 0; local scanned = 0
  local previousAt = nil; local cutoff = now - window
  local raw = redis.call('ZRANGEBYSCORE', KEYS[1], '(' .. cutoff, '+inf', 'WITHSCORES')
  if #raw / 2 ~= eventCount then return {-2} end
  for index = 1, #raw, 2 do
    local event = parse_log_event(raw[index], raw[index + 1])
    if not event or event.at > meta.observed or (previousAt and event.at < previousAt) then return {-2} end
    scanned = scanned + 1; released = released + event.cost; previousAt = event.at
    if not retryAt and released >= deficit then retryAt = event.at + window end
  end
  if scanned ~= eventCount or released ~= meta.used or not retryAt then return {-2} end
end
if deleteExisting then redis.call('DEL', KEYS[1])
elseif expiredCount > 0 and redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, now - window) ~= expiredCount then return {-2} end
if allowed == 1 then
  redis.call('ZADD', KEYS[1], now, 'e|' .. now .. '|' .. meta.sequence .. '|' .. cost)
end
if metaMember and not deleteExisting then redis.call('ZREM', KEYS[1], metaMember) end
redis.call('ZADD', KEYS[1], -1, log_meta_member(meta, now))
redis.call('PEXPIRE', KEYS[1], math.max(1, resetAt - now))
if allowed == 1 then return {1, remaining, resetAt} end
return {0, remaining, math.max(1, retryAt - now), resetAt}
`}`,
	decode: decodeReply,
})

const SCRIPTS: Record<
	ResolvedRatePolicy['algorithm'],
	RedisScriptDefinition<
		readonly [string],
		readonly [string, string, string, string, string],
		RedisRatesReply
	>
> = {
	'token-bucket': ConsumeTokenBucket,
	'fixed-window': ConsumeFixedWindow,
	'sliding-window-counter': ConsumeSlidingCounter,
	'sliding-window-log': ConsumeSlidingLog,
}

export const RedisRatesBackendConfig = v.object({
	keyPrefix: v.optional(
		v.pipe(
			v.string(),
			v.maxLength(256),
			v.check(isWellFormedUnicode, 'keyPrefix must be well-formed Unicode'),
		),
		'pluxel:rates:',
	),
})

export type RedisRatesBackendPluginConfig = v.InferOutput<typeof RedisRatesBackendConfig>

/** Redis 7 backend using one server-timed, single-key Lua transition per decision. */
@Plugin(RatesBackend)
export class RedisRatesBackendPlugin extends RatesBackend {
	private readonly config = this.configs.use(RedisRatesBackendConfig)
	private readonly runners = new Map<
		ResolvedRatePolicy['algorithm'],
		RedisScriptRunner<
			readonly [string],
			readonly [string, string, string, string, string],
			RedisRatesReply
		>
	>()
	private readonly encodedPolicies = new WeakMap<
		Readonly<ResolvedRatePolicy>,
		readonly [string, string, string]
	>()

	constructor(private readonly redis: Redis) {
		super()
	}

	async consume(request: RatesBackendConsumeRequest): Promise<RateDecision> {
		const policy = request.policy
		const digest = createHash('sha256').update(request.key).digest('hex')
		const owner = canonicalBackendOwner(request.owner)
		let runner = this.runners.get(policy.algorithm)
		if (!runner) {
			runner = this.redis.scripts.use(SCRIPTS[policy.algorithm])
			this.runners.set(policy.algorithm, runner)
		}
		let encodedPolicy = this.encodedPolicies.get(policy)
		if (!encodedPolicy) {
			encodedPolicy = Object.freeze([
				String(policy.limit),
				String(policy.windowMs),
				String(policy.algorithm === 'token-bucket' ? policy.burst : 0),
			])
			this.encodedPolicies.set(policy, encodedPolicy)
		}
		const reply = await runner({
			keys: [`${this.config.keyPrefix}v3:${digest}`],
			arguments: [...encodedPolicy, owner, String(request.cost)],
		})
		if (reply.kind === 'decision') return reply.decision
		throw new RatesPolicyConflictError(reply.active, policy)
	}
}

function canonicalBackendOwner(owner: PluginNodeAddress | null): string {
	return owner === null ? 'global' : formatPluginNodeReference(owner)
}

function script(algorithm: string, body: string) {
	return defineRedisScript<
		readonly [string],
		readonly [string, string, string, string, string],
		RedisRatesReply
	>({
		name: `pluxel.rates.consume-${algorithm}-v2`,
		numberOfKeys: 1,
		source: `${LUA_COMMON}\n${body}`,
		decode: decodeReply,
	})
}

function decodeReply(reply: unknown): RedisRatesReply {
	if (!Array.isArray(reply) || reply.length === 0)
		throw new TypeError('Expected a non-empty rates reply tuple.')
	const code = replyInteger(reply[0], 'status')
	if (code === -2)
		throw new TypeError('Stored rates state is corrupt or uses an unsupported format.')
	if (code === -1) {
		if (reply.length !== 5) throw new TypeError('Expected a policy conflict tuple.')
		const algorithm = String(reply[1])
		const limit = positiveReplyInteger(reply[2], 'active limit')
		const windowMs = positiveReplyInteger(reply[3], 'active window')
		const burst = nonNegativeReplyInteger(reply[4], 'active burst')
		if (algorithm === 'token-bucket') {
			if (burst < 1) throw new TypeError('Expected a positive active burst.')
			return { kind: 'conflict', active: Object.freeze({ algorithm, limit, windowMs, burst }) }
		}
		if (
			algorithm !== 'fixed-window' &&
			algorithm !== 'sliding-window-counter' &&
			algorithm !== 'sliding-window-log'
		) {
			throw new TypeError('Expected a supported active algorithm.')
		}
		if (burst !== 0) throw new TypeError('Expected zero burst for a window algorithm.')
		return { kind: 'conflict', active: Object.freeze({ algorithm, limit, windowMs }) }
	}
	if (code === 1) {
		if (reply.length !== 3) throw new TypeError('Expected an allowed rates tuple.')
		return {
			kind: 'decision',
			decision: {
				denied: false,
				remaining: nonNegativeReplyInteger(reply[1], 'remaining'),
				resetAt: nonNegativeReplyInteger(reply[2], 'resetAt'),
			},
		}
	}
	if (code !== 0 || reply.length !== 4) throw new TypeError('Expected a denied rates tuple.')
	return {
		kind: 'decision',
		decision: {
			denied: true,
			remaining: nonNegativeReplyInteger(reply[1], 'remaining'),
			retryAfterMs: positiveReplyInteger(reply[2], 'retryAfterMs'),
			resetAt: nonNegativeReplyInteger(reply[3], 'resetAt'),
		},
	}
}

function replyInteger(value: unknown, name: string): number {
	const number = Number(value)
	if (!Number.isSafeInteger(number)) throw new TypeError(`Expected integer ${name}.`)
	return number
}

function nonNegativeReplyInteger(value: unknown, name: string): number {
	const number = replyInteger(value, name)
	if (number < 0) throw new TypeError(`Expected non-negative ${name}.`)
	return number
}

function positiveReplyInteger(value: unknown, name: string): number {
	const number = replyInteger(value, name)
	if (number < 1) throw new TypeError(`Expected positive ${name}.`)
	return number
}
