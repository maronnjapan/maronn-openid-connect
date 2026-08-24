---
"@maronn-openid-connect/experimental": patch
---

core の minor リリースに合わせて publish する

experimental 自体の実装は変えていない。RELEASE.md「core の minor / major では experimental も一緒にリリースする」に従い、広い peer range のまま core だけが先に進む状態（公開済みの古い experimental が、まだ組み合わせて検証していない core を受け入れる状態）を作らないためのペアリングである。
