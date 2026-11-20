import type { CommandContext } from 'gunshi'
import { renderHeader } from 'gunshi/renderer'

// Gunshi's lazy-command resolution drops command.rendering; scope the supported CLI override by its resolved path.
export async function renderCliHeader(ctx: Readonly<CommandContext>): Promise<string> {
	return ['dev', 'script'].includes(ctx.commandPath[0] ?? '') ? '' : renderHeader(ctx)
}
