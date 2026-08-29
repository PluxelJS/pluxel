# `@pluxel/auth`

Pluxel 官方 Management 验证插件。它用一个互斥配置覆盖密码、密码加 TOTP，以及完整 OIDC 登录，并把同一身份判断提供给 Workbench、Management 操作 API 和需要复用管理身份的其他插件。

Runtime 负责管理面的入口闸门和物理连接事实；本插件只负责凭据、协议与会话。没有 active 且 ready 的验证 provider 时，远程 Management 一律关闭，只显示 SSH tunnel 指引；localhost 仍可用于恢复和首次设置，不需要一次性 bootstrap token。
provider ready 后，所有来源（包括 localhost）都必须通过本插件认证；本地恢复不是一条长期绕过路径。

## 运行前提

- Host 必须安装 Management Plane；`workbench: { enabled: true }` 会同时安装它，headless host 可使用 `management: {}`。
- `password`、`password-totp` 和 confidential OIDC 需要 `vault: {}` 保存 secret。Vault 必须已经解锁。
- public OIDC 不保存 client secret，因此不要求 Vault。
- 外部登录必须使用由 Pluxel physical carrier 提供的 HTTPS；`Host`、`Forwarded` 或请求 URL 不能伪造安全连接。
- 当前进程中最多运行一个 Management 验证 provider。

生产 static Node listener 可以直接终止 TLS。`PLUXEL_TLS_CERT` 与 `PLUXEL_TLS_KEY` 必须成对配置，值可以是内联 PEM 内容或 PEM 文件路径；
private key 受保护时可另设可选的 `PLUXEL_TLS_PASSPHRASE`。不安全的远程请求会在 Runtime 调用 provider 前被拒绝。

将 `AuthPlugin` 加入 catalog、设置一个 mode，再按部署需要打开自动启动策略或在当前进程启动它。`mode` 省略时默认为 `password`。

```ts
import { AuthPlugin } from '@pluxel/auth'

host.add(AuthPlugin)
host.cfg(AuthPlugin).set({ mode: { type: 'password' } })
host.start(AuthPlugin)
```

首次启动本地账号或 confidential OIDC 时，provider 会以 `ready: false` 正常运行。通过 SSH tunnel 打开本机设置页，保存凭据后立即变为
ready；从这一刻起，同一个 loopback 请求也需要认证：

```sh
ssh -L 3000:127.0.0.1:3000 user@host
```

```text
http://127.0.0.1:3000/__pluxel/admin-access/setup
```

端口不是 `3000` 时，两端改成实际 Pluxel 监听端口。设置页只接受 Runtime 根据 physical peer 判定的 localhost 请求。

## 三种模式

### 密码

```ts
host.cfg(AuthPlugin).set({
	mode: { type: 'password' },
})
```

设置页创建或替换唯一的本地 admin 账号。密码至少 12 个字符；Vault 只保存固定参数的 scrypt verifier，不保存明文密码。

### 密码加 TOTP

```ts
host.cfg(AuthPlugin).set({
	mode: { type: 'password-totp' },
})
```

设置页先生成 authenticator secret，再要求当前 6 位验证码确认。登录接受 30 秒周期的前后一个窗口，并持久化最后接受的 counter，拒绝重复使用同一验证码。

### OIDC

```ts
host.cfg(AuthPlugin).set({
	mode: {
		type: 'oidc',
		issuer: 'https://id.example.com',
		clientId: 'pluxel-admin',
		publicOrigin: 'https://admin.example.com',
		clientKind: 'confidential',
		scopes: ['openid', 'profile', 'email'],
		requiredClaims: { groups: 'pluxel-admins' },
		bearerAudience: 'https://admin.example.com/api',
	},
})
```

Confidential client 的 secret 不进入普通 Plugin config；通过 localhost 设置页写入 Vault。`clientKind: 'public'` 使用 Authorization Code + PKCE，且不需要 secret。浏览器登录始终使用 discovery、PKCE S256、state、nonce、issuer/audience/`azp` 和 JWKS 校验。

`bearerAudience` 省略时只接受本插件签发的浏览器 session；设置后还会接受以该 API audience 签发的 bearer access token。它应是身份提供商为 Management API 定义的 audience，不要仅因为 OIDC client ID 已存在就随意复用。

## 在其他插件中复用

需要同一管理身份的插件通过正常 constructor dependency 消费 `AuthPlugin`：

```ts
import { AuthPlugin } from '@pluxel/auth'
import { BasePlugin, Plugin } from '@pluxel/runtime'

@Plugin()
class OperationsPlugin extends BasePlugin {
	constructor(private readonly auth: AuthPlugin) {
		super()
	}

	async authorize(request: Request) {
		return await this.auth.authenticate(request)
	}
}
```

`authenticate()` 返回与 Management provider 相同的 allow/deny decision；它不会暴露密码、TOTP secret、OIDC token 或原始 claims。该公开复用入口只接受 URL 为 HTTPS 的 Request，不尝试从 hostname 推断物理 locality；Runtime 自己的 Management 闸门使用 carrier 提供的可信 locality 与 transport facts。

## 当前边界

- 三种 mode 互斥，不提供按请求 fallback 或组合多个身份源。
- 本地模式只有一个 admin 账号，没有多用户、RBAC、recovery code 或密码重置邮件。
- OIDC 不保存 refresh token，也不实现身份提供商 logout。
- 会话只存在于当前 Plugin generation；stop、restart、凭据替换或 mode 变化都会撤销。
- 登录失败限速、session、OIDC pending state 和 TOTP enrollment 都有固定内存上界；这些是安全实现策略，不作为调优配置。

内部所有 secret 与凭据记录由 Vault 拥有。普通 config、状态页、日志和 `authenticate()` 结果都不包含 secret。
