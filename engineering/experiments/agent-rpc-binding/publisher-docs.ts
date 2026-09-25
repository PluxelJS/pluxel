import { read } from './provider/commands.js'
import { writeDocs } from './provider/commands-docs.js'

export const publication = { id: 'records', commands: { write: writeDocs, read } } as const
