import { f, v } from '@pluxel/runtime'
import { workbench } from '@pluxel/runtime/workbench'

const PingResult = v.object({
	state: v.pipe(v.picklist(['not-run', 'succeeded', 'failed']), f.formMeta({ title: 'State' })),
	latencyMs: v.pipe(v.nullable(v.number()), f.formMeta({ title: 'Round-trip time (ms)' })),
	errorType: v.pipe(v.nullable(v.string()), f.formMeta({ title: 'Error type' })),
})

const RedisStatus = v.pipe(
	v.object({
		connection: v.pipe(
			v.picklist(['ready', 'reconnecting', 'closed']),
			f.formMeta({ title: 'Connection' }),
		),
		recentErrorType: v.pipe(v.nullable(v.string()), f.formMeta({ title: 'Recent error type' })),
		ping: v.pipe(PingResult, f.formMeta({ title: 'Latest PING' })),
	}),
	f.formMeta({ title: 'Runtime status' }),
)

const PingInput = v.object({
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
	connection: workbench.content({
		document: workbench.markdown(import.meta.url, './workbench-guide.md', {
			status: workbench.data(RedisStatus),
			ping: workbench.action({ label: 'Send PING', input: PingInput }),
		}),
		placement: workbench.tab({
			label: 'Connection',
			icon: workbench.icons.PlugConnected,
			order: 80,
		}),
	}),
})
