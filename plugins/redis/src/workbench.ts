import { f, v } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'
import { isRedisConnectionId } from './validation.ts'

const MAX_CONNECTIONS = 64

const PingResult = v.object({
	state: v.pipe(v.picklist(['not-run', 'succeeded', 'failed']), f.formMeta({ title: 'State' })),
	latencyMs: v.pipe(v.nullable(v.number()), f.formMeta({ title: 'Round-trip time (ms)' })),
	errorType: v.pipe(v.nullable(v.string()), f.formMeta({ title: 'Error type' })),
})

const RedisConnectionStatus = v.object({
	id: v.pipe(
		v.string(),
		v.check(isRedisConnectionId, 'Expected a valid connection ID'),
		f.formMeta({ title: 'Connection ID' }),
	),
	database: v.pipe(v.number(), v.integer(), v.minValue(0), f.formMeta({ title: 'Database' })),
	connection: v.pipe(
		v.picklist(['ready', 'reconnecting', 'closed']),
		f.formMeta({ title: 'State' }),
	),
	recentErrorType: v.pipe(v.nullable(v.string()), f.formMeta({ title: 'Recent error type' })),
	ping: v.pipe(PingResult, f.formMeta({ title: 'Latest PING' })),
})

const RedisStatus = v.pipe(
	v.object({
		connections: v.pipe(
			v.array(RedisConnectionStatus),
			v.maxLength(MAX_CONNECTIONS),
			f.formMeta({ title: 'Connections' }),
		),
	}),
	f.formMeta({ title: 'Runtime status' }),
)

const PingInput = v.object({
	connectionId: v.pipe(
		v.string(),
		v.check(isRedisConnectionId, 'Enter a valid configured connection ID'),
		f.formMeta({ title: 'Connection ID' }),
	),
	payload: v.pipe(
		v.string(),
		v.maxLength(256),
		f.formMeta({
			title: 'Payload',
			description: 'Optional payload returned by Redis. Leave empty for a plain PING.',
		}),
	),
})

export type RedisWorkbenchStatus = v.InferOutput<typeof RedisStatus>

export const RedisWorkbench = workbench.define({
	connections: workbench.content({
		document: workbench.markdown(import.meta.url, './workbench-guide.md', {
			status: workbench.data(RedisStatus),
			ping: workbench.action({ label: 'Send PING', input: PingInput }),
		}),
		placement: workbench.tab({
			label: 'Connections',
			icon: workbench.icons.PlugConnected,
			order: 80,
		}),
	}),
})
