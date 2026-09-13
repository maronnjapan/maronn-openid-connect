---
"@maronn-openid-connect/cli": patch
---

express / fastify / nextjs 向けに生成される `conformance.test.ts` の未定義参照を修正しました。

introspection の契約テストが呼ぶ `conformanceAuthorizationCode()` を定義するヘルパーは、これまで hono のテンプレートにしか差し込まれていませんでした。そのため web 標準系 3 フレームワークの生成物は「呼び出しはあるが定義が無い」状態で、`vitest` を実行すると `ReferenceError: conformanceAuthorizationCode is not defined` で 1 件失敗していました。`introspection` は既定で有効なので、既定の生成物が該当します。

ヘルパーを web 標準テンプレートにも差し込むことで、生成された契約テストがそのまま緑になります。`--disable introspection` で生成した場合は、呼び出し側と同じ条件でヘルパーも出力されません（生成プロジェクトの `noUnusedLocals` 対策）。hono の生成物はバイト単位で従来と同一です。
