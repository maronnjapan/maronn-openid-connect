---
'@maronn-openid-connect/cli': minor
---

同意 POST の承認判定を fail-closed にする（`action` の肯定値を明示検出する）

**破壊的変更**: 生成される同意ハンドラは、これまで `action === 'deny'` のときだけ拒否し、
**それ以外のすべての値（未送信・空文字・未知の値）を承認として認可コードを発行していた**。
承認を「否定の否定」で判定する denylist 方式のため、値の欠落・変更に対して常に危険側
（承認側）へ倒れていた。

OIDC Core 1.0 §3.1.2.4 は「Once the End-User is authenticated, the Authorization Server MUST
obtain an authorization decision before releasing information to the Relying Party.」と定めており、
decision が取得できたと判定する条件は OP の責務である。「否定語に一致しないこと」で代替すると、
利用者が生成された view の `value="approve"` を `allow` / `accept` などへ書き換えた時点で
**拒否ボタンだけが正しく動き、承認は常に成立する**状態になり、画面上は正常に見えるため
誤りに気づけない。

cli（hono / express / fastify / nextjs のすべてに適用）:

- 同意ハンドラを allowlist 判定に変更した。肯定値は `approve`（現行 view と同じ値）に固定し、
  `approve` でも `deny` でもない値は認可コードを発行せず、`recordConsent` も呼ばない
- 未知値はクライアントへ `access_denied` で戻さず、OP 自身の 400 エラーページで止める。
  `access_denied` は「resource owner が拒否した」意味（OIDC Core 1.0 §3.1.2.6）であり、
  「決定が取得できなかった」とは意味論が異なるため
- Next.js の Server Action 版（`src/app/consent/actions.ts`）も同じ判定にし、こちらは
  App Router の作法に合わせて OP 自身の `/oidc-error` ページへ送る
- view（`views.ts` / `consent/page.tsx`）とハンドラが期待する値の対応を、テンプレート内の
  コメントで明示した
- 生成される `conformance.test.ts` に、`action` の未送信・空文字・未知値が認可コードを
  発行しないことを固定する契約テストを追加した

**移行**: 生成コードの同意 view を改変し、Approve ボタンの `value` を `approve` 以外へ
変更している場合、承認が 400 になる。`value="approve"` へ戻すか、ハンドラ側の
`if (action !== 'approve')` を合わせて変更すること。フォームを再構成して POST している
自動化テスト・スクリプトも、`action=approve` を明示的に送る必要がある。
