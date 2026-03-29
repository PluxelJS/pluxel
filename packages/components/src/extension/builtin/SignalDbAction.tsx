import { Button, Group, Loader, Paper, Stack, Text } from '@mantine/core'
import { useMemo, useState } from 'react'
import type { BuiltinActionBlock } from '@pluxel/runtime/web/extensions'
import {
	useGlobalExtensionContext,
	useSignalDbCollectionsState,
} from '@pluxel/runtime/web'
import { applySignalDbWrite } from './_shared'

export function BuiltinSignalDbAction({
	pluginName,
	block,
}: {
	pluginName: string
	block: BuiltinActionBlock
}) {
	const ctx = useGlobalExtensionContext()
	const transport = ctx.services.transport
	const collections = useSignalDbCollectionsState(
		transport,
		pluginName,
		useMemo(() => [block.write.collection], [block.write.collection]),
	)
	const [submitting, setSubmitting] = useState(false)

	const notifySuccess = () => {
		const notify = ctx.services.ui.notify
		const success = block.feedback?.success
		if (!success) return
		notify({
			tone: 'success',
			title: success.title ?? block.label,
			message: success.message,
			...(success ?? {}),
		})
	}

	const notifyError = (err: unknown) => {
		const notify = ctx.services.ui.notify
		const error = block.feedback?.error
		if (!error) return
		notify({
			tone: 'error',
			title: error.title ?? '执行失败',
			message: error.message ?? (err instanceof Error ? err.message : String(err ?? 'unknown error')),
			...(error ?? {}),
		})
	}

	const onClick = async () => {
		if (submitting) return
		const confirm = block.confirm
		if (confirm?.message) {
			const ok = await ctx.services.ui.confirm(confirm)
			if (!ok) return
		}

		setSubmitting(true)
		try {
			applySignalDbWrite(collections as any, block.write, {})
			notifySuccess()
		} catch (error) {
			notifyError(error)
		} finally {
			setSubmitting(false)
		}
	}

	return (
		<Paper withBorder radius="md" p="sm" shadow="xs">
			<Stack gap="xs">
				{block.description ? (
					<Text size="xs" c="dimmed">
						{block.description}
					</Text>
				) : null}
				<Group justify="flex-end">
					<Button size="xs" variant="light" onClick={onClick} disabled={submitting}>
						{submitting ? (
							<Group gap={6} wrap="nowrap">
								<Loader size="xs" />
								<Text size="xs">执行中…</Text>
							</Group>
						) : (
							block.label
						)}
					</Button>
				</Group>
			</Stack>
		</Paper>
	)
}
