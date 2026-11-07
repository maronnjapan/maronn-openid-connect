# テスト（OIDC Provider のテストの一覧）

OIDC Provider にどんなテストがあるかを見るページです。
地図（apps/map）とは別のアプリで、地図と同じ Worker の `/tests/` で配信します。

## 見られるもの

- ホーム：テストの数（API / E2E / ユニット / ツール）、最新の実行の結果、正常系と異常系の割合と、エンドポイントごとのテストの数です。
  プルリクエストのビルドでは、一番上にその PR のテストへの一行が出ます。
- エンドポイント：処理の流れ（手順）と手順ごとのユニットテストの数、そのエンドポイントのテストの一覧です。
  エンドポイントのテストは、その API・E2E のテストと、手順の関数のユニットテストです（Next.js の手順は、そのブロックが呼ぶ関数のユニットテスト）。
  ユニットテストの無い手順には「テストなし」と出ます。
  手順を選ぶと、その手順のユニットテストだけに絞り込みます。
  手順より下で届く関数（cookie、データベース、ストアなど）は「ほかの関数」に畳んであり、選ぶとその関数のユニットテストに絞り込みます。
- テストの詳細：タイトル（英語と日本語）、結果（ターゲットごとの時間）、確かめていること（最初の 6 件）、送るリクエスト、テストのコードです。
  コードは「このテストだけ」と「ファイル全体」を切り替えられます。
- ファイル：テストのファイルの一覧と、ファイルごとのテストとコードです。
  テストを選ぶと、横のコードでそのテストの行に印が付きます（スマートフォンでは詳細が開きます）。
- この PR：プルリクエストのビルドでは、追加・変更・名前の変更・削除したテストと、関連するテストが変わっていない実装の変更です。

テストの不足のうち画面に出すのは、ユニットテストの無い手順だけです。
ほかの不足（`tests.json` の `gaps`）と、対象や観点を読めなかったテストの数（`unknown`）はデータに残し、画面には一覧にしません。

画面はすべて URL のハッシュ（`#/endpoint/hono/token` など）で開けます。

## データ

データは地図のデータの手順（apps/map/scripts/build-data.mjs）が `apps/tests/public/data` に書き出します。
このアプリの `build` はデータを作りません。
リポジトリのルートで次のどちらかを実行してください。

```sh
pnpm run build:map
# 地図のパッケージをビルド済みなら、データだけ
pnpm --filter @maronn-openid-connect/map run data
```

データが無いときは、ページにこの手順を表示します。

## 開発

```sh
pnpm --filter @maronn-openid-connect/tests dev        # http://127.0.0.1:3620（PORT で変更）
pnpm --filter @maronn-openid-connect/tests build      # dist/ に public/data も含めて出力
pnpm --filter @maronn-openid-connect/tests preview
pnpm --filter @maronn-openid-connect/tests typecheck
pnpm --filter @maronn-openid-connect/tests test       # src/lib のテスト
```

## 配信

地図のビルド（`pnpm --filter @maronn-openid-connect/map build`）が、このアプリをビルドして `apps/map/dist/tests/` にコピーします。
地図の Worker（apps/map/wrangler.jsonc）がそれを `<地図の URL>/tests/` で配信するので、プルリクエストのプレビューにもこのページが付きます。
ページはデータを `./data/` から相対パスで読むので、`/tests/` のようにサブパスに置いても動きます。
