import { BasePlugin, Plugin } from '@pluxel/core'
import { Result, TaggedError } from '@pluxel/core/better-result'
import { CommandError, defineCommand, validation } from '@pluxel/commands'
import { Type, obj } from '@pluxel/commands/typebox'
import { Commands } from '@pluxel/services/commands'

export class NoteNotFound extends TaggedError('NoteNotFound')<{ id: string }> {}
type Note = Readonly<{ id: string; text: string }>

@Plugin()
export class NotesWithResults extends BasePlugin {
	find(id: string): Result<Note, NoteNotFound> {
		return id === 'welcome'
			? Result.ok({ id, text: 'Welcome' })
			: Result.err(new NoteNotFound({ id }))
	}

	protected override init(): void {
		this.ctx.require(Commands).register(
			defineCommand({
				name: 'notes.lookup',
				description: 'Read a note, including explicit absence.',
				behavior: { kind: 'query', world: 'closed' },
				input: obj({ id: Type.String() }),
				output: obj({ id: Type.String(), text: Type.String() }),
				execute: ({ id }) => {
					const result = this.find(id)
					if (result.isErr()) {
						throw new CommandError('INPUT_VALIDATION', 'Note not found', {
							details: {
								issues: [validation.constraint('id', 'Note not found', { code: 'note_not_found' })],
							},
						})
					}
					return result.value
				},
			}),
		)
	}
}
