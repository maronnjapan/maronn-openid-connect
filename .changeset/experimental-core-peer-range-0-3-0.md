---
"@maronn-openid-connect/experimental": patch
---

`@maronn-openid-connect/core` の peer range の下限を `>=0.3.0` へ上げました。

experimental はモノレポ内の core（= 次に publish される core）だけを相手にビルド・テストされるため、それより古い core を下限に据えると、一度も試していない組み合わせを「動く」と宣言することになります（RELEASE.md「peer range は『下限』を宣言する」）。core が 0.3.0 へ上がるのに合わせた下限の追随で、実装の変更はありません。
