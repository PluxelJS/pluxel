import { read } from './provider/commands.js'
import { writeNewOutput } from './provider/commands-output.js'

export const publication = { id: 'records', commands: { write: writeNewOutput, read } } as const
