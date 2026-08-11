---
"@maronn-openid-connect/experimental": patch
---

`@maronn-openid-connect/core` の peer range 下限を `>=0.2.0` へ引き上げました。

core が `createJwkSigningKeyProvider` / `resolveSigningKeyProvider` の追加で 0.2.0 になるためです。experimental はモノレポ内の core だけを相手にビルド・テストされるので、それより古い core を許可すると「一度も試していない組み合わせ」を動くと宣言することになります（RELEASE.md「peer range は『下限』を宣言する」）。

実装は変わっていません。core 0.1.x と組み合わせて使っていた場合は、core を 0.2.0 以上へ更新してください。
