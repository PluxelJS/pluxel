import type { HostConfigMutation } from '@pluxel/host/embedded'
import { Button, Group, Text } from '@mantine/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	AutoForm,
	buildEditableConfigPatch,
	useAutoFormCtx,
	type AutoFormOptions,
} from 'valibot-form/web'
import type { RuleKey } from '../../src/rules'
import { writeRuleConfig, type RuleForm } from './management'

function SyncDraft({
	incoming,
	baseline,
	adopt,
}: {
	incoming: RuleForm
	baseline: RuleForm
	adopt: (next: RuleForm) => void
}) {
	const { form, reset } = useAutoFormCtx()
	const observed = useRef(incoming.revision)
	function reload() {
		adopt(incoming)
		reset({ ...incoming.saved })
	}
	useEffect(() => {
		if (observed.current === incoming.revision) return
		observed.current = incoming.revision
		if (incoming.revision !== baseline.revision && !form.state.isDirty) {
			adopt(incoming)
			reset({ ...incoming.saved })
		}
	}, [incoming, baseline.revision, form, reset, adopt])
	return incoming.revision !== baseline.revision ? (
		<Button type="button" size="xs" variant="light" onClick={reload}>
			载入最新配置
		</Button>
	) : null
}

export function ConfigEditor({
	ruleKey,
	model,
	refresh,
}: {
	ruleKey: RuleKey
	model: RuleForm
	refresh: () => Promise<void>
}) {
	const [baseline, setBaseline] = useState(model)
	const [message, setMessage] = useState('')
	const [busy, setBusy] = useState(false)
	const writing = useRef(false)
	const adopt = useCallback((next: RuleForm) => {
		setBaseline(next)
		setMessage('')
	}, [])
	const commit = useCallback(
		async (
			change: HostConfigMutation | undefined,
			acknowledge: (raw: Record<string, unknown>) => void,
		) => {
			if (writing.current) return
			writing.current = true
			setBusy(true)
			try {
				const result = await writeRuleConfig(ruleKey, baseline.revision, change)
				const raw = { ...result.managedInput }
				setBaseline({ ...model, saved: raw, revision: result.managedRevision })
				acknowledge(raw)
				const receipt = {
					applied: '已保存并应用',
					deferred: '已保存，启用时采用',
					'saved-not-applied': ['已保存，当前实例尚未采用。', result.applyFailure?.message].join(
						'',
					),
				}
				setMessage(receipt[result.application])
			} catch (error) {
				setMessage(error instanceof Error ? error.message : String(error))
			} finally {
				await refresh()
				writing.current = false
				setBusy(false)
			}
		},
		[ruleKey, baseline.revision, model, refresh],
	)
	const options = useMemo(
		() =>
			({
				defaultValues: baseline.saved,
				canSubmitWhenInvalid: true,
				onSubmit: ({ value, formApi }) =>
					commit(buildEditableConfigPatch(model.fields, value, baseline.saved), (raw) => {
						if (formApi.state.values === value) formApi.reset(raw)
					}),
			}) satisfies AutoFormOptions<Record<string, unknown>>,
		[model.fields, baseline.saved, commit],
	)

	return (
		<AutoForm fields={model.fields} formOpts={options}>
			<fieldset disabled={busy} className="config-fields">
				<AutoForm.Fields />
				<AutoForm.Actions>
					{({ dirty, submitting, reset }) => (
						<Group mt="sm">
							<Button size="xs" type="submit" disabled={!dirty || submitting}>
								保存配置
							</Button>
							<Button
								size="xs"
								variant="subtle"
								type="button"
								disabled={submitting}
								onClick={() => void commit(undefined, reset)}
							>
								恢复插件默认配置
							</Button>
						</Group>
					)}
				</AutoForm.Actions>
			</fieldset>
			<SyncDraft incoming={model} baseline={baseline} adopt={adopt} />
			<Text size="sm" role="status">
				{message || model.error}
			</Text>
		</AutoForm>
	)
}
