import { read } from './provider/commands.js'
import { writeNewInput } from './provider/commands-input.js'

export const publication = { id: 'records', commands: { write: writeNewInput, read } } as const
