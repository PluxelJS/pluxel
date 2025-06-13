export function splitChanges(changes: Change[]) {
	const addOrReplace: Change[] = []
	const removeOrReplace: Change[] = []

	for (const ch of changes) {
		// type 为 add 或 replace，都归到 addOrReplace
		if (ch.type === 'add' || ch.type === 'replace') {
			addOrReplace.push(ch)
		}
		// type 为 remove 或 replace，都归到 removeOrReplace
		if (ch.type === 'remove' || ch.type === 'replace') {
			removeOrReplace.push(ch)
		}
	}

	return { addOrReplace, removeOrReplace }
}
