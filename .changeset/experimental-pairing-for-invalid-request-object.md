---
"@maronn-openid-connect/experimental": patch
---

core の minor リリースに合わせて publish し、core peer range の下限を `>=0.3.0` へ上げる

experimental 自体の実装は変えていない。`invalid_request_object` の追加で core が 0.3.0 へ上がるため、RELEASE.md「peer range は『下限』を宣言する」に従って下限を追随させた。experimental はモノレポ内の core だけを相手にビルド・テストされるので、それより古い core を下限に残すと一度も試していない組み合わせを「動く」と宣言することになる。あわせて RELEASE.md「core の minor / major では experimental も一緒にリリースする」に従い、広い peer range のまま core だけが先に進む状態を作らないためのペアリングでもある。
