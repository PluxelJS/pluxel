/** Converts the stored full Discord API base into discord.js REST's separate base/version fields. */
export function resolveDiscordRestOptions(apiBase: string): { api: string; version: string } {
	const url = new URL(apiBase)
	const match = /\/v(\d+)$/.exec(url.pathname)
	if (!match) return { api: apiBase.replace(/\/+$/, ''), version: '10' }
	url.pathname = url.pathname.slice(0, -match[0].length)
	return { api: url.toString().replace(/\/+$/, ''), version: match[1]! }
}
