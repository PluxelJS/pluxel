import assert from 'node:assert/strict'

export function workspaceFile(page, path, folder = 'report') {
	return page.locator(
		`button[role="treeitem"][data-folder=${JSON.stringify(folder)}][data-path=${JSON.stringify(path)}]`,
	)
}

/** Reveal the native Worksplit Files tool. */
export async function revealWorkspaceFile(page, path, folder = 'report') {
	await page.getByRole('tab', { name: '文件', exact: true }).waitFor()
	const root = workspaceFile(page, '', folder)
	if (!(await root.isVisible())) await page.getByRole('tab', { name: '文件', exact: true }).click()
	if ((await root.getAttribute('aria-expanded')) === 'false') await root.click()
	let directory = ''
	for (const part of path.split('/').slice(0, -1)) {
		directory += `${part}/`
		const item = workspaceFile(page, directory, folder)
		if ((await item.getAttribute('aria-expanded')) === 'false') await item.click()
	}
	const file = workspaceFile(page, path, folder)
	await file.waitFor({ state: 'visible' })
	return file
}

export async function assertWorkspaceFile(page, path, folder = 'report') {
	await page.waitForFunction(
		({ path: expectedPath, folder: expectedFolder }) =>
			[...document.querySelectorAll('button[role="treeitem"][aria-selected="true"]')].some(
				(item) => item.dataset.folder === expectedFolder && item.dataset.path === expectedPath,
			),
		{ path, folder },
	)
	const panel = page.locator(
		`.workspace-panel[data-folder=${JSON.stringify(folder)}][data-file=${JSON.stringify(path)}]:visible`,
	)
	await panel.waitFor({ state: 'visible' })
	assert.equal(await panel.locator('.active-file').textContent(), path)
}

export async function chooseWorkspaceFile(page, path, folder = 'report') {
	const file = await revealWorkspaceFile(page, path, folder)
	await file.click()
	await assertWorkspaceFile(page, path, folder)
}
