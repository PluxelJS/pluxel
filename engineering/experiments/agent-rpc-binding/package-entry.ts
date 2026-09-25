import { read, write } from '@fixture/records-provider'

export const publication = { id: 'records', commands: { write, read } } as const
