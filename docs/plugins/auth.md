---
title: Management 认证
description: 用官方 Auth Plugin 为 Workbench 和 Management API 提供 OIDC、密码或密码加 TOTP。
---

`@pluxel/auth` 是官方 Management authentication provider。它保护 Workbench、Management RPC/SSE/HTTP 和 Security/Vault 管理面，
不会自动保护业务 Plugin 路由。provider ready 后，所有来源（包括 loopback）都必须认证；只有 provider 不存在或尚未 ready 时，物理
loopback 才拥有恢复入口。

## 启用前提

宿主先启用 Management/Workbench。Password、password + TOTP 与 confidential OIDC 还需要 Vault：

```ts no-twoslash
configure: () => ({
	vault: {},
	workbench: { enabled: true },
})
```

Public OIDC 不保存 client secret，可以省略 `vault`。

然后把 `AuthPlugin` 加入正常 Plugin catalog 并 enable。它没有 runtime 特例；停止或替换 generation 会立即撤销远程准入和全部内存 session。

生产 Node launcher 默认监听 `0.0.0.0`。Auth Plugin ready 后，remote 与 loopback 都进入相同认证流程。在 provider 缺席或 Auth Plugin
尚未 ready 时，remote/unknown peer 只能看到 SSH tunnel 指引；真实 loopback 可以进入 Workbench 完成恢复。首次设置不需要 bootstrap token：

```sh
ssh -L 3000:127.0.0.1:3000 user@host
```

打开 `http://127.0.0.1:3000`，配置插件 mode，再访问 `/__pluxel/admin-access/setup`。

## 三种模式

### Password

```ts no-twoslash
{
	mode: {
		type: 'password'
	}
}
```

在本地 setup 页面保存管理账号和至少 12 字符的密码。Vault 保存固定参数的 scrypt verifier，不保存明文；登录创建有界、generation-local、
opaque 的 `HttpOnly` session。

### Password + TOTP

```ts no-twoslash
{
	mode: {
		type: 'password-totp'
	}
}
```

setup 会生成 authenticator provisioning secret，并要求先提交一个有效 code 才保存账号。登录必须同时验证 password 和 TOTP；最后接受的
counter 在创建 session 前写入 Vault 并 flush，以拒绝并发或重启后的 code replay。不支持 TOTP-only。

### OIDC

```ts no-twoslash
{
	mode: {
		type: 'oidc',
		issuer: 'https://id.example.com',
		clientId: 'pluxel-admin',
		publicOrigin: 'https://pluxel.example.com',
		clientKind: 'public',
	}
}
```

浏览器使用 Authorization Code + PKCE、state 和 nonce；成功后同样只创建本地 opaque session，不保存 access/refresh token。confidential
client 把 `clientKind` 设为 `confidential`，再通过本地 setup 页面把 client secret 写入 Vault。若配置 `bearerAudience`，Management API
也接受经过 issuer/audience/JWKS/requiredClaims 验证的 Bearer JWT；省略时只接受浏览器 session。

callback 固定为：

```text
<publicOrigin>/__pluxel/admin-access/oidc/callback
```

## 部署安全

外部 password/OIDC 流程要求物理 carrier 是 HTTPS；不安全的远程请求会在调用 provider 前被拒绝。生产 static Node listener 可以直接终止
TLS：`PLUXEL_TLS_CERT` 和 `PLUXEL_TLS_KEY` 必须成对配置，值可以是内联 PEM 内容或 PEM 文件路径；加密 private key 可再设置可选的
`PLUXEL_TLS_PASSPHRASE`。

Runtime 不信任 `Forwarded`/`X-Forwarded-*`，也不会从 URL hostname 推断本地访问。不要让同机反向代理通过 `127.0.0.1` 回源
Management，因为后端无法把它和 SSH tunnel 区分；使用非 loopback private/container upstream，或直接在 Pluxel carrier 终止 TLS。

普通 Management 请求只做 O(1) 内存 session lookup，不读 Vault、不跑 scrypt、不做 OIDC discovery。session、pending OIDC flow、登录限速、
enrollment 和 cache 都有固定上界，并在 Plugin generation 结束时清空。
