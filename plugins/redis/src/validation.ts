export function isWellFormedUnicode(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index)
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1)
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false
			index++
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false
		}
	}
	return true
}

export function isRedisConnectionId(value: string): boolean {
	return /^[a-z][a-z0-9._-]{0,63}$/.test(value)
}
