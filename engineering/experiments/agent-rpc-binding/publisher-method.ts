import { read, write } from './provider/commands.js'

export const publication = { id: 'records', commands: { write, read, inspect: read } } as const
