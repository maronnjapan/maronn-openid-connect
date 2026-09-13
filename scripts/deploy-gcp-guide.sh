#!/usr/bin/env bash
# Shared Google Cloud Run deploy guide for the single-process Node.js
# samples (express-flyio / fastify-flyio) that persist state to a local
# node:sqlite file. This is a second real-infrastructure target alongside
# Fly.io (scripts/lib/deploy-fly-node-sample.sh), to verify the same
# CLI-generated OP code against Cloud Run's container runtime model.
#
# Like the Fly.io script, this is verification tooling for maintainers of
# this repository: it spins up a sample OP on real infrastructure so the
# sqlite-on-local-disk storage backend can be checked against an actual
# Cloud Run deployment. It is not a production deployment guide for
# library users — samples/* exist for internal verification of
# CLI-generated code (see the repository README.md).
#
# Usage: deploy-gcp-guide.sh <express-flyio|fastify-flyio|all> [options]
#
# The only required argument is the target. Everything else that can be
# derived is derived, and the script only prompts interactively for the
# handful of things it cannot decide alone:
#   - which GCP project to use, when none is configured yet (see below)
#   - gcloud / docker login or setup, if not already done
#
# GCP project resolution (the point most first-time users get stuck on):
#   1. --project, if given, is used (and created if it doesn't exist yet).
#   2. Otherwise the project id saved from a previous run is reused
#      (${ROOT_DIR}/.deploy-gcp/project-id).
#   3. Otherwise the script lists any GCP projects already on the account
#      and asks which to use.
#   4. If there are none — the common case for an account that has never
#      used GCP before — it does NOT just ask you to type a project id
#      blind. It says so explicitly, generates a candidate id, and offers
#      to run `gcloud projects create` for you.
#   Billing is handled the same way: Cloud Run requires a billing account
#   linked to the project. If none is linked yet, the script looks for a
#   billing account on your Google account and offers to link it
#   automatically; if you have none at all, it prints the console URL to
#   set one up (that step cannot be done from the CLI alone).
#
# Docker requirement: unlike Fly (which builds on a remote builder), Cloud
# Run here is deployed by building the image locally with `docker build`
# and pushing it to Artifact Registry. This assumes Docker runs natively
# in this shell — i.e. you are on Linux, or inside WSL on Windows with
# either Docker Desktop's WSL integration enabled or Docker Engine
# installed directly in the WSL distribution. Plain Docker Desktop on
# Windows/macOS works too as long as `docker build` / `docker push`
# succeed from wherever this script runs; it is not tested against that
# setup here.
#
# Persistence caveat: Cloud Run instances have no durable local disk.
# Each service is pinned to exactly one always-on instance
# (--min-instances=1 --max-instances=1, mirroring Fly's single-machine
# constraint) so the in-memory signing key and the sqlite file on local
# disk survive for that instance's lifetime — but neither survives a
# platform-initiated instance restart, and --min-instances=1 keeps a
# billable instance running continuously. Verification tooling only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/guide.sh
. "${SCRIPT_DIR}/lib/guide.sh"

STATE_DIR="${ROOT_DIR}/.deploy-gcp"
PROJECT_ID_FILE="${STATE_DIR}/project-id"

ALL_SAMPLES=(express-flyio fastify-flyio)

TARGET=""
PROJECT_ID="${GCP_PROJECT_ID:-}"
REGION="asia-northeast1"
REPO_NAME="maronn-openid-connect"
DRY_RUN=0

print_help() {
  cat <<EOF
Usage: deploy-gcp-guide.sh <express-flyio|fastify-flyio|all> [options]

  express-flyio   express-flyio サンプルのみを Cloud Run にデプロイ
  fastify-flyio   fastify-flyio サンプルのみを Cloud Run にデプロイ
  all             上記2サンプルをまとめてデプロイ（GCPプロジェクトの
                   確認・API有効化・Artifact Registryリポジトリ作成は
                   1回だけ行い、ビルド・push・デプロイをサンプルごとに
                   繰り返す）

Options:
  --project <id>   使用するGCPプロジェクトID（省略時は下記を参照）
  --region <region>  Cloud Run / Artifact Registry のリージョン（既定: ${REGION}）
  --repo <name>    Artifact Registry のDockerリポジトリ名（既定: ${REPO_NAME}）
  --dry-run        実際には何も実行せず、実行予定のコマンドだけ表示する
  -h, --help       このヘルプを表示

引数なし（ターゲット以外）で実行するとガイド付きでデプロイします:
  1. gcloud / docker が無ければインストール方法を案内
  2. gcloud 未ログインなら 'gcloud auth login' を起動
  3. GCPプロジェクトを決定:
     - --project があればそれを使用（無ければ作成を提案）
     - 前回値（${PROJECT_ID_FILE}）を再利用
     - なければ既存プロジェクト一覧から選択、1つも無ければ新規作成を提案
       （「プロジェクトを作っていないのにIDを聞かれて戸惑う」を避けるため、
       未作成のケースを明示的に案内する分岐です）
  4. 課金アカウントが未リンクなら、既存の課金アカウントへのリンクを提案
     （課金アカウント自体が無い場合はConsoleでの作成が必要なためURLを案内）
  5. 必要なAPI（Cloud Run / Artifact Registry）を有効化
  6. Artifact Registry の Dockerリポジトリを作成（既存なら再利用）
  7. サンプルごとに: ローカルで docker build → push → Cloud Run へデプロイ
     （--min-instances=1 --max-instances=1 で単一インスタンスに固定）
  8. デプロイ後に判明するCloud RunのURLをissuerとして反映し直し、
     Discoveryエンドポイントでissuerの一致を検証

Dockerはこのシェルからローカルで直接使えることが前提です（Linux、または
WSL上でDocker DesktopのWSL統合かDocker Engineを有効にした環境）。

非対話環境（CI等）では --project または GCP_PROJECT_ID が必須です。
EOF
}

if [ $# -eq 0 ]; then
  print_help >&2
  exit 1
fi

case "$1" in
  express-flyio|fastify-flyio|all) TARGET="$1"; shift ;;
  -h|--help) print_help; exit 0 ;;
  *)
    guide_err "不明なターゲットです: $1"
    print_help >&2
    exit 1
    ;;
esac

while [ $# -gt 0 ]; do
  case "$1" in
    --project) PROJECT_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --repo) REPO_NAME="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) print_help; exit 0 ;;
    *) guide_err "不明な引数です: $1（--help で使い方を表示）"; exit 1 ;;
  esac
done

if [ "${TARGET}" = "all" ]; then
  TARGETS=("${ALL_SAMPLES[@]}")
else
  TARGETS=("${TARGET}")
fi

run() {
  guide_info "実行: $*"
  if [ "${DRY_RUN}" = "1" ]; then
    return 0
  fi
  "$@"
}

guide_step "GCP Cloud Run へのデプロイを開始します（対象: ${TARGETS[*]}）"

# ── gcloud / docker の確認 ──────────────────────────────────────────────
if [ "${DRY_RUN}" != "1" ]; then
  if ! command -v gcloud >/dev/null 2>&1; then
    guide_err "gcloud CLI が見つかりません。https://cloud.google.com/sdk/docs/install を参照してインストール後、再実行してください。"
    exit 1
  fi
  if ! command -v docker >/dev/null 2>&1; then
    guide_err "docker が見つかりません。Linuxの場合はディストリビューションのパッケージから、WSLの場合はDocker DesktopのWSL統合を有効にするか、WSL内に直接Docker Engineをインストールしてください（https://docs.docker.com/engine/install/）。"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    if grep -qi microsoft /proc/version 2>/dev/null; then
      guide_err "Dockerデーモンに接続できません（WSL環境を検出）。Docker Desktopの『Settings > Resources > WSL Integration』でこのディストリビューションを有効にするか、WSL内でDocker Engineを起動してください。"
    else
      guide_err "Dockerデーモンに接続できません。'sudo systemctl start docker' 等でDocker Engineを起動するか、現在のユーザーが docker グループに所属しているか確認してください。"
    fi
    exit 1
  fi
fi
guide_ok "gcloud / docker を確認しました。"

# ── ログイン状態の確認 ──────────────────────────────────────────────────
if [ "${DRY_RUN}" != "1" ]; then
  active_account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
  if [ -z "${active_account}" ]; then
    guide_warn "gcloud に未ログインです。"
    if ! guide_is_tty; then
      guide_err "非対話環境ではログインできません。先に 'gcloud auth login' を済ませてください。"
      exit 1
    fi
    guide_info "これから 'gcloud auth login' を起動します。ブラウザが開くので、Googleアカウントでログインしてください。"
    guide_run gcloud auth login
  fi
  guide_ok "ログイン済み: $(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || echo '(確認済み)')"
fi

# ── GCPプロジェクトの決定 ───────────────────────────────────────────────
project_exists() {
  gcloud projects describe "$1" >/dev/null 2>&1
}

generate_project_id_candidate() {
  local suffix
  suffix="$(node -e 'console.log(require("node:crypto").randomBytes(3).toString("hex"))' 2>/dev/null || date +%s | tail -c 7)"
  printf 'maronn-oidc-poc-%s' "${suffix}"
}

create_new_project() {
  local default_id
  default_id="$(generate_project_id_candidate)"
  guide_info "GCPプロジェクトIDは全世界で一意である必要があります（6〜30文字、小文字英字・数字・ハイフン、先頭は英字）。"
  guide_ask PROJECT_ID "作成する新しいプロジェクトのID" "${default_id}"
  guide_step "プロジェクト ${PROJECT_ID} を作成します"
  run gcloud projects create "${PROJECT_ID}" --name="maronn-openid-connect OIDC PoC"
}

choose_existing_or_create_project() {
  local raw
  raw="$(gcloud projects list --format='value(projectId)' 2>/dev/null || true)"
  local -a ids=()
  while IFS= read -r pid; do
    [ -z "${pid}" ] && continue
    ids+=("${pid}")
  done <<< "${raw}"

  if [ "${#ids[@]}" -eq 0 ]; then
    guide_warn "GCPプロジェクトが1つも見つかりませんでした（このアカウントでGCPプロジェクトを作成したことが無い可能性があります）。"
    guide_info "プロジェクトIDをいきなり尋ねる代わりに、新規プロジェクトの作成をここから案内します。"
    create_new_project
    return 0
  fi

  guide_info "既存のGCPプロジェクトが見つかりました。使用するものを選んでください。"
  local i=1
  for pid in "${ids[@]}"; do
    printf '  %d) %s\n' "${i}" "${pid}" >&2
    i=$((i + 1))
  done
  printf '  n) 新しいプロジェクトを作成する\n' >&2

  local choice
  guide_ask choice "番号、または新規作成は n" "n"
  if [[ "${choice}" =~ ^[0-9]+$ ]] && [ "${choice}" -ge 1 ] && [ "${choice}" -le "${#ids[@]}" ]; then
    PROJECT_ID="${ids[$((choice - 1))]}"
  else
    create_new_project
  fi
}

resolve_project() {
  if [ "${DRY_RUN}" = "1" ]; then
    PROJECT_ID="${PROJECT_ID:-<your-gcp-project-id>}"
    guide_info "--dry-run のため、プロジェクトの確認・作成は行いません（想定値: ${PROJECT_ID}）。"
    return 0
  fi

  if [ -n "${PROJECT_ID}" ]; then
    if project_exists "${PROJECT_ID}"; then
      guide_ok "プロジェクト ${PROJECT_ID} を使用します。"
    else
      guide_warn "指定されたプロジェクト '${PROJECT_ID}' が見つかりませんでした。"
      if ! guide_is_tty; then
        guide_err "非対話環境では未作成のプロジェクトを自動作成しません。先に 'gcloud projects create ${PROJECT_ID}' を実行するか、既存のプロジェクトIDを --project に指定してください。"
        exit 1
      fi
      if guide_confirm "このIDで新規プロジェクトを作成しますか？" y; then
        guide_step "プロジェクト ${PROJECT_ID} を作成します"
        run gcloud projects create "${PROJECT_ID}" --name="maronn-openid-connect OIDC PoC"
      else
        PROJECT_ID=""
      fi
    fi
  fi

  if [ -z "${PROJECT_ID}" ] && [ -f "${PROJECT_ID_FILE}" ]; then
    PROJECT_ID="$(head -n 1 "${PROJECT_ID_FILE}" | tr -d '[:space:]')"
    if [ -n "${PROJECT_ID}" ] && project_exists "${PROJECT_ID}"; then
      guide_info "前回使用したプロジェクトを再利用します: ${PROJECT_ID}（変更する場合は --project を指定）"
    else
      PROJECT_ID=""
    fi
  fi

  if [ -z "${PROJECT_ID}" ]; then
    guide_step "GCPプロジェクトを確認します"
    if ! guide_is_tty; then
      guide_err "非対話環境ではプロジェクトを自動選択しません。--project または GCP_PROJECT_ID でプロジェクトIDを指定してください。"
      exit 1
    fi
    choose_existing_or_create_project
  fi

  mkdir -p "${STATE_DIR}"
  printf '%s\n' "${PROJECT_ID}" > "${PROJECT_ID_FILE}"
}

resolve_project
guide_ok "使用するGCPプロジェクト: ${PROJECT_ID}"

# ── 課金アカウントの確認 ────────────────────────────────────────────────
ensure_billing() {
  if [ "${DRY_RUN}" = "1" ]; then
    guide_info "--dry-run のため、課金設定の確認は行いません。"
    return 0
  fi

  local enabled
  enabled="$(gcloud billing projects describe "${PROJECT_ID}" --format='value(billingEnabled)' 2>/dev/null || echo "False")"
  if [ "${enabled}" = "True" ]; then
    guide_ok "課金アカウントはリンク済みです。"
    return 0
  fi

  guide_warn "プロジェクト ${PROJECT_ID} に課金アカウントがリンクされていません。Cloud Runのデプロイには課金の有効化が必須です。"
  local raw
  raw="$(gcloud billing accounts list --filter='open=true' --format='value(name)' 2>/dev/null || true)"
  local -a accounts=()
  while IFS= read -r line; do
    [ -z "${line}" ] && continue
    accounts+=("${line#billingAccounts/}")
  done <<< "${raw}"

  if [ "${#accounts[@]}" -eq 0 ]; then
    guide_err "利用可能な課金アカウントが見つかりませんでした。Cloud Consoleで課金アカウントを作成し、このプロジェクトにリンクしてください: https://console.cloud.google.com/billing/linkedaccount?project=${PROJECT_ID}"
    exit 1
  elif [ "${#accounts[@]}" -eq 1 ]; then
    if guide_confirm "課金アカウント ${accounts[0]} をこのプロジェクトにリンクしますか？" y; then
      run gcloud billing projects link "${PROJECT_ID}" --billing-account "${accounts[0]}"
    else
      guide_err "課金アカウントのリンクなしではCloud Runにデプロイできません。"
      exit 1
    fi
  else
    guide_info "複数の課金アカウントが見つかりました。"
    local i=1
    for acc in "${accounts[@]}"; do
      printf '  %d) %s\n' "${i}" "${acc}" >&2
      i=$((i + 1))
    done
    local choice
    guide_ask choice "使用する課金アカウントの番号" "1"
    if [[ "${choice}" =~ ^[0-9]+$ ]] && [ "${choice}" -ge 1 ] && [ "${choice}" -le "${#accounts[@]}" ]; then
      run gcloud billing projects link "${PROJECT_ID}" --billing-account "${accounts[$((choice - 1))]}"
    else
      guide_err "無効な選択です。"
      exit 1
    fi
  fi
}

ensure_billing

# ── API有効化 / Artifact Registry ───────────────────────────────────────
guide_step "必要なAPIを有効化します"
run gcloud services enable run.googleapis.com artifactregistry.googleapis.com --project "${PROJECT_ID}"

guide_step "Artifact Registry リポジトリを確認します"
repo_exists=0
if [ "${DRY_RUN}" != "1" ] && gcloud artifacts repositories describe "${REPO_NAME}" --location "${REGION}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  repo_exists=1
fi
if [ "${repo_exists}" = "1" ]; then
  guide_ok "リポジトリ ${REPO_NAME} は既に存在するため再利用します。"
else
  run gcloud artifacts repositories create "${REPO_NAME}" \
    --repository-format=docker \
    --location "${REGION}" \
    --project "${PROJECT_ID}"
fi

guide_step "Docker の認証情報を設定します"
run gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet --project "${PROJECT_ID}"

# ── サンプルごとにビルド・push・デプロイ ─────────────────────────────────
TAG="$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
DEPLOYED_URLS=()

deploy_sample() {
  local sample="$1"
  local service_name="maronn-oidc-${sample}"
  local image="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/${sample}:${TAG}"

  guide_step "[${sample}] イメージをビルドします（ビルドコンテキスト: リポジトリルート）"
  run docker build -f "${ROOT_DIR}/samples/${sample}/Dockerfile" -t "${image}" "${ROOT_DIR}"

  guide_step "[${sample}] イメージをpushします"
  run docker push "${image}"

  guide_step "[${sample}] Cloud Run にデプロイします（単一インスタンス固定）"
  guide_info "Cloud RunのURLはデプロイ後にしか判明しないため、まずissuer未設定でデプロイし、URL判明後にissuerを反映し直します。"
  run gcloud run deploy "${service_name}" \
    --image "${image}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --platform managed \
    --allow-unauthenticated \
    --min-instances 1 \
    --max-instances 1 \
    --set-env-vars "HOST=0.0.0.0,OIDC_SQLITE_PATH=/tmp/oidc.sqlite"

  if [ "${DRY_RUN}" = "1" ]; then
    guide_ok "[${sample}] --dry-run のため、issuerの反映・検証は行いません。"
    return 0
  fi

  local service_url
  service_url="$(gcloud run services describe "${service_name}" --region "${REGION}" --project "${PROJECT_ID}" --format='value(status.url)')"
  if [ -z "${service_url}" ]; then
    guide_err "[${sample}] Cloud RunのURLを取得できませんでした。"
    exit 1
  fi

  guide_step "[${sample}] issuer を ${service_url} として反映します"
  run gcloud run services update "${service_name}" \
    --project "${PROJECT_ID}" \
    --region "${REGION}" \
    --update-env-vars "ISSUER=${service_url}"

  guide_step "[${sample}] Discovery エンドポイントで issuer の一致を確認します"
  local discovery
  discovery="$(curl -sf "${service_url}/.well-known/openid-configuration" || true)"
  if [ -z "${discovery}" ]; then
    guide_err "[${sample}] Discoveryエンドポイントへの疎通確認に失敗しました: ${service_url}/.well-known/openid-configuration"
    exit 1
  fi
  if ! printf '%s' "${discovery}" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{const m=JSON.parse(d);process.exit(m.issuer==='${service_url}'?0:1)})"; then
    guide_err "[${sample}] Discoveryのissuerが ${service_url} と一致しません。"
    exit 1
  fi
  guide_ok "[${sample}] デプロイが完了しました: ${service_url}"
  DEPLOYED_URLS+=("${sample} => ${service_url} (gcloud run services delete ${service_name} --region ${REGION} --project ${PROJECT_ID} --quiet で削除)")
}

for sample in "${TARGETS[@]}"; do
  deploy_sample "${sample}"
done

if [ "${DRY_RUN}" = "1" ]; then
  guide_ok "--dry-run のため、実際のGCP API呼び出しは行いませんでした。"
  exit 0
fi

guide_step "完了"
for line in "${DEPLOYED_URLS[@]}"; do
  guide_info "${line}"
done
guide_info "動作確認例: curl <issuer>/.well-known/openid-configuration"
guide_info "Artifact Registryのイメージも削除する場合: gcloud artifacts repositories delete ${REPO_NAME} --location ${REGION} --project ${PROJECT_ID} --quiet"
