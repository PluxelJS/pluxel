import { read } from './provider/commands.js'

export const publication = { id: 'records', commands: { write: read, read } } as const
