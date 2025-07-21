// formContext.ts
import { createFormHook, createFormHookContexts } from '@tanstack/react-form'

// 拿到 fieldContext 和 formContext，用于后续绑定
export const { fieldContext, formContext } = createFormHookContexts() // :contentReference[oaicite:1]{index=1}

export const { useAppForm } = createFormHook({
	fieldContext,
	formContext,
	// 这里可以预绑定你自己的 UI 组件库，比如 Mantine 的 TextInput/NumberInput/SubmitButton……
	fieldComponents: {},
	formComponents: {},
})
