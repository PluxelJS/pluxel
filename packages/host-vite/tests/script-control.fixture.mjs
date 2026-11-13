import { createConnection } from 'node:net'
import { openScriptSocketSession } from '@pluxel/host/agent/socket'
import { connectScriptControl } from '@pluxel/host/agent/transport'

/** The built-artifact scenarios consume the same public carrier and control client as CLI. */
export async function openProjectControl(instance) {
	const socket = createConnection(instance.socketPath)
	socket.setTimeout(10000, () => socket.destroy(new Error('Script control deadline reached')))
	const session = openScriptSocketSession(socket)
	try {
		const control = await connectScriptControl(
			session.remote,
			{
				protocol: instance.protocol,
				instanceId: instance.instanceId,
				nonce: instance.nonce,
			},
			{ instanceId: instance.instanceId },
		)
		return {
			describe: () => control.describe(),
			submit: (input) => control.submit(input),
			result: (runId) => control.result(runId),
			control: (input) => control.control(input),
			[Symbol.dispose]() {
				try {
					control[Symbol.dispose]()
				} finally {
					session.close()
				}
			},
		}
	} catch (error) {
		session.close()
		throw error
	}
}
