import { read } from './provider/commands.js'
import { writeNewImplementation } from './provider/commands-implementation.js'

export const publication = {
	id: 'records',
	commands: { write: writeNewImplementation, read },
} as const
