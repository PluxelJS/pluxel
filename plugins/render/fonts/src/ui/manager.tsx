import { MantineProvider } from '@mantine/core'
import { useEffect, useRef, useState } from 'react'
import { FontManagerContent } from './index.tsx'
import {
	fontManagerSnapshotQuery,
	installManagedFontMutation,
	managerScope,
	removeManagedFontMutation,
	setPreferredFontMutation,
} from './manager.scope.ts'

function bytesLabel(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

function FontsManagerPanel() {
	const { host } = managerScope.useWorkbench()
	const snapshot = fontManagerSnapshotQuery.useQuery()
	const setPreferredFont = setPreferredFontMutation.useMutation()
	const installFont = installManagedFontMutation.useMutation()
	const removeFont = removeManagedFontMutation.useMutation()
	const mounted = useRef(false)
	const fileReadId = useRef(0)
	const [readingFile, setReadingFile] = useState(false)
	const [localError, setLocalError] = useState<unknown | null>(null)

	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
			fileReadId.current += 1
		}
	}, [])

	const resetErrors = () => {
		setLocalError(null)
		setPreferredFont.reset()
		installFont.reset()
		removeFont.reset()
	}

	const install = async (file: File, family: string): Promise<boolean> => {
		const currentSnapshot = snapshot.data
		if (!currentSnapshot) return false
		if (file.size > currentSnapshot.limits.maxFontBytes) {
			setLocalError(`字体文件超过 ${bytesLabel(currentSnapshot.limits.maxFontBytes)} 上限`)
			return false
		}
		resetErrors()
		const current = ++fileReadId.current
		setReadingFile(true)
		try {
			// File.arrayBuffer() has no AbortSignal. This guard only prevents a late RPC after close.
			const data = new Uint8Array(await file.arrayBuffer())
			if (!mounted.current || fileReadId.current !== current) return false
			await installFont.mutateAsync({
				fileName: file.name,
				family: family.trim() || undefined,
				data,
			})
			return mounted.current && fileReadId.current === current
		} catch (caught) {
			if (mounted.current && fileReadId.current === current) setLocalError(caught)
			return false
		} finally {
			if (mounted.current && fileReadId.current === current) setReadingFile(false)
		}
	}

	const loading = snapshot.isPending || snapshot.isFetching
	const saving =
		readingFile || setPreferredFont.isPending || installFont.isPending || removeFont.isPending
	const error =
		localError ??
		(setPreferredFont.status === 'error'
			? setPreferredFont.error
			: installFont.status === 'error'
				? installFont.error
				: removeFont.status === 'error'
					? removeFont.error
					: snapshot.status === 'error'
						? snapshot.error
						: null)

	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<FontManagerContent
				snapshot={snapshot.data}
				loading={loading}
				saving={saving}
				error={error}
				onRefresh={() => {
					resetErrors()
					snapshot.invalidate()
				}}
				onPreferredFamilyChange={(family) => {
					resetErrors()
					setPreferredFont.mutate(family)
				}}
				onInstall={install}
				onRemove={(id) => {
					resetErrors()
					removeFont.mutate(id)
				}}
			/>
		</MantineProvider>
	)
}

export default managerScope.render(FontsManagerPanel)
