---
'@maronn-openid-connect/cli': minor
---

関数カタログが関数の本体から処理の流れを読み、生成コードのすべての関数とエンドポイントに振る舞いの説明を付ける

- 関数カタログは、関数の本体から呼ぶ関数を実行順に並べた処理の流れ（分岐の条件、`return` と `throw`）を読む。resolver や store のメソッドの呼び出し（`consentResolver.recordConsent()` など）は、そのインターフェースのメンバーの JSDoc で説明する。リポジトリの地図（`apps/map`）の関数のページが、これをエンドポイントのステップと同じ形の図にする
- カタログが関数の範囲と呼び出しを読むときに、正規表現リテラルとテンプレートリテラルを文字列やコメントと同じく見分ける。これまで `/"/g` のような正規表現の後ろを読み違え、`htmlResponse` などの関数と 28 の呼び出しを `explain` に出していなかった
- JSDoc と関数宣言のあいだに `// eslint-disable-next-line` の行があっても、その JSDoc を関数の説明として読む（`applyOidc`）
- `graph --format json` のエンドポイントに、そのエンドポイントの振る舞いを書いた `summary` を足す。生成コードの各 `endpoint.ts` の JSDoc の 1 段落目から読む
- 生成コードの関数で JSDoc の無かったもの（export しない関数、Next.js の Route Handler、React コンポーネント）と、resolver や store のインターフェースのメンバーに、振る舞いを書いた JSDoc を足す。各 `endpoint.ts` の JSDoc はエンドポイントの振る舞いを書いた文にする。生成コードの挙動は変わらない
