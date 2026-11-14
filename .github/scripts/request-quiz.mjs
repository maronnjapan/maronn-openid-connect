import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const quizRepository = 'maronnjapan/readRFCInMobile';
export const quizWorkflow = 'quiz-authoring.yml';
const categories = ['vocabulary', 'knowledge', 'flow', 'design', 'debugging', 'comparison', 'implementation'];

/** Validate a manually requested PR quiz and build the receiving workflow's inputs. */
export function quizRequest({ prNumber, specId = '', focusPaths = '', part = '1', questionCount = '7', questionCategories = categories.join(',') }) {
  const positive = (value) => /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
  if (!positive(prNumber) || !positive(part) || Number(part) > 375) throw new Error('PR number and part must be positive integers (part: 1–375).');
  if (!positive(questionCount) || Number(questionCount) < 2 || Number(questionCount) > 10) throw new Error('Question count must be 2–10.');
  if (specId && !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(specId)) throw new Error('Specify a registered specification ID, or leave it empty for a PR-only quiz.');
  const selected = questionCategories.split(',').map((c) => c.trim());
  if (!selected.length || selected.length > Number(questionCount) || new Set(selected).size !== selected.length || selected.some((c) => !categories.includes(c))) throw new Error('Choose distinct quiz categories within the question count.');
  const paths = focusPaths.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
  if (focusPaths.length > 2000 || paths.length > 20 || paths.some((p) => p.startsWith('/') || /[\\\x00-\x1f]/.test(p) || p.replace(/\/$/, '').split('/').some((s) => ['', '.', '..'].includes(s)))) throw new Error('Specify up to 20 repository paths; directories end with /.');
  return { ref: 'main', inputs: { operation: 'generate', code_source: 'maronn-openid-connect', pr_number: String(prNumber),
    spec_id: specId, focus_paths: paths.join(','), part: String(part), question_count: String(questionCount), question_categories: selected.join(',') } };
}

/** Dispatch only a generation request; reviewed quizzes are published in the receiving repository. */
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
      part: process.env.QUIZ_PART || '1', questionCount: process.env.QUESTION_COUNT || '7', questionCategories: process.env.QUESTION_CATEGORIES || categories.join(',') };
    if (process.argv.includes('--dry-run')) console.log(JSON.stringify(quizRequest(input), null, 2));
    else {
      const url = await requestQuiz(input, { token: process.env.QUIZ_DISPATCH_TOKEN });
      console.log(`Quiz generation requested: ${url}`);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `PR #${input.prNumber} の作問を依頼しました。\n\n[readRFCInMobile の実行・生成候補を確認する](${url})\n\n候補は draft です。レビュー・公開は readRFCInMobile で行います。\n`);
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
