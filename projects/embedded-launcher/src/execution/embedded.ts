import { transport } from './embedded-transport'
import { createSession } from './session'
import { documentStorage } from './storage'
import * as plugins from '../plugins'
const session = createSession(
	transport,
	{
		configStorage: documentStorage(transport, 'config'),
		stateStorage: documentStorage(transport, 'state'),
	},
	Object.values(plugins),
)
export const dispatch = session.dispatch
export const close = session.close
