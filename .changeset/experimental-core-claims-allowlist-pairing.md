---
"@maronn-openid-connect/experimental": patch
---

core の minor リリース（`claims` パラメータのクレーム名アロウリスト導入）に合わせた同時リリースです。experimental 自体の実装変更はありません。

experimental は core を広い peer range で参照しているため、core だけが先に進むと「公開済みの古い experimental が、まだ組み合わせて試していない新しい core を受け入れる」状態になります。これを避けるため、core の minor / major では experimental も同時にリリースします（RELEASE.md「core の minor / major では experimental も一緒にリリースする」）。あわせて core の peer range 下限を `>=0.2.0` へ上げました。
