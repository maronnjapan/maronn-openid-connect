import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const quizRepository = 'maronnjapan/readRFCInMobile';
export const quizWorkflow = 'quiz-authoring.yml';
const categories = ['vocabulary', 'knowledge', 'flow', 'design', 'debugging', 'comparison', 'implementation'];

/** Send PR information for material preparation; authoring is a separate operation. */
export function quizRequest({ prNumber, specId = '', focusPaths = '', questionCount = '7', questionCategories = categories.join(',') }) {
  const positive = (value) => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
  if (!positive(prNumber)) throw new Error('PR number must be a positive integer.');
  if (!positive(questionCount)) throw new Error('The optional question count must be a positive integer.');
  if (specId && !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(specId)) throw new Error('Specify a registered specification ID, or leave it empty for a PR-only quiz.');
  const selected = questionCategories.split(',').map((c) => c.trim());
  if (!selected.length || new Set(selected).size !== selected.length || selected.some((c) => !categories.includes(c))) throw new Error('Choose distinct quiz categories.');
  const paths = focusPaths.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
  if (paths.some((p) => p.startsWith('/') || /[\\\x00-\x1f]/.test(p) || p.replace(/\/$/, '').split('/').some((s) => ['', '.', '..'].includes(s)))) throw new Error('Specify repository paths; directories end with /.');
  return { ref: 'main', inputs: { operation: 'prepare', code_source: 'maronn-openid-connect', pr_number: String(prNumber),
    spec_id: specId, focus_paths: paths.join(','), question_count: String(questionCount), question_categories: selected.join(',') } };
}

/** Dispatch material preparation without starting AI generation or publishing questions. */
export async function requestQuiz(input, { token, fetcher = fetch } = {}) {
  const body = quizRequest(input);
  if (!token) throw new Error('Set QUIZ_DISPATCH_TOKEN in the quiz-authoring Environment: a fine-grained token with Actions: write on maronnjapan/readRFCInMobile.');
  const response = await fetcher(`https://api.github.com/repos/${quizRepository}/actions/workflows/${quizWorkflow}/dispatches`, {
    method: 'POST', headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error',
  });
  if (response.status !== 204) throw new Error(`Quiz dispatch failed (${response.status}). Check the token's repository and Actions permission, and merge the reader integration workflow first.`);
  return `https://github.com/${quizRepository}/actions/workflows/${quizWorkflow}`;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const input = { prNumber: process.env.PR_NUMBER, specId: process.env.SPEC_ID || '', focusPaths: process.env.FOCUS_PATHS || '',
      questionCount: process.env.QUESTION_COUNT || '7', questionCategories: process.env.QUESTION_CATEGORIES || categories.join(',') };
    if (process.argv.includes('--dry-run')) console.log(JSON.stringify(quizRequest(input), null, 2));
    else {
      const url = await requestQuiz(input, { token: process.env.QUIZ_DISPATCH_TOKEN });
      console.log(`PR quiz materials requested: ${url}`);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `PR #${input.prNumber} の情報を送り、作問資料の保存を依頼しました。\n\n[readRFCInMobile の実行・作問資料を確認する](${url})\n\n資料から問題 JSON を別途作成し、readRFCInMobile に反映して公開できます。この依頼では AI は実行しません。\n`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
