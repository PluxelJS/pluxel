import type { DestinationStream } from 'pino'
import pinoPretty from 'pino-pretty'

let prettyStream: DestinationStream | undefined

export function getPrettyStream(): DestinationStream {
	if (prettyStream) return prettyStream
	prettyStream = pinoPretty({
		colorize: true,
		ignore: 'pid,hostname,pluginId,context,caller',
		messageFormat: (log, messageKey) => {
			const msg = typeof log[messageKey] === 'string' ? log[messageKey] : ''
			const caller = typeof (log as any).caller === 'string' ? (log as any).caller : ''
			return caller ? `${msg} (${caller})` : msg
		},
		translateTime: 'SYS:standard',
	})
	return prettyStream
}
