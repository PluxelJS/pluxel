---
title: Auth 身份认证插件
description: 为 Workbench 工作台与 Management 管理接口提供 OIDC 单点登录、本地密码与 TOTP 双因素认证。
---

`@pluxel/plugin-auth` 是官方提供的身份认证插件。它为管理通道（Workbench 前端和 Management API）提供强大的认证保护，支持 OIDC（单点登录）、本地管理员密码以及 TOTP 两步验证（2FA）。

## 安装与快速配置

```sh
pnpm add @pluxel/plugin-auth
```

在应用入口中注册 `AuthPlugin` 并设置认证模式：

```ts no-twoslash
import { defineHostApplication } from '@pluxel/host'
import { servicesPreset } from '@pluxel/services/preset'
import { AuthPlugin } from '@pluxel/plugin-auth'

export default defineHostApplication(async (startup) => ({
	name: 'my-app',
	plugins: [AuthPlugin],
	policy: { autoStart: [AuthPlugin] },
	config: {
		records: [
			{
				owner: AuthPlugin,
				config: {
					mode: { type: 'password' }, // 可选 'password'、'password_totp' 或 'oidc'
				},
			},
		],
	},
	services: await servicesPreset(startup, {}),
}))
```

首次启动服务后，访问 Workbench 地址，系统会引导管理员设置初始登录账号与密码。

## 接入 OIDC 单点登录

如果企业已有通用的身份提供商（如 Keycloak、Auth0、Okta），可将认证模式配置为 `oidc`：

```ts no-twoslash
{
	mode: {
		type: 'oidc',
		issuer: 'https://auth.example.com',
		clientId: 'pluxel-admin',
		publicOrigin: 'https://my-app.example.com',
		clientKind: 'public', // 支持 'public' (PKCE) 或 'confidential'
	}
}
```

并在你的身份认证提供商后台中，将回调地址配置为：
```text
https://my-app.example.com/__pluxel/admin-access/oidc/callback
```

登录完成后，认证插件会自动签发安全的 `HttpOnly` Cookie 保持会话，敏感的 Token 和密码不会暴露在前端存储中。
