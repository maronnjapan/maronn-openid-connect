/**
 * EXPERIMENTAL (RFC 9396): the demo authorization-details type of this app.
 *
 * A payment_initiation type shaped after the example of RFC 9396 §2.1
 * Figure 1, registered by dev-data.ts so tests/e2e can exercise the rar feature
 * over the protocol. It is this app's own development data — the CLI never
 * copies this file into generated code, and a generated provider accepts no
 * type until its operator injects definitions through config.rarTypes.
 */
import {
  RarError,
  type AuthorizationDetail,
  type AuthorizationDetailTypeDefinition,
} from '@maronn-openid-connect/experimental/rar';

/** The actions the demo type accepts (RFC 9396 §2.1 uses "initiate"). */
const PAYMENT_ACTIONS = ['initiate', 'status', 'cancel'] as const;

/** The display verb of each accepted action on the consent screen. */
const ACTION_VERBS: Record<(typeof PAYMENT_ACTIONS)[number], string> = {
  initiate: 'Initiate a payment of',
  status: 'Check the status of a payment of',
  cancel: 'Cancel a payment of',
};

/**
 * payment_initiation の要素を検証し、`actions` の値域と `instructedAmount` の構造に違反があれば `RarError` を投げる。
 *
 * `actions` は `initiate` / `status` / `cancel` だけからなる非空の配列、
 * `instructedAmount` は `{ currency: 大文字 3 文字, amount: 小数 2 桁の文字列 }` の
 * オブジェクトでなければならない（RFC 9396 §2.1 の例の形）。
 * message は固定の ASCII 文言で、入力値を含めない。
 *
 * @spec RFC 9396 §2.1
 * @throws {RarError} `actions` か `instructedAmount` が上の形でないとき
 */
function validatePaymentInitiation(detail: AuthorizationDetail): void {
  const actions = detail.actions;
  if (
    !Array.isArray(actions) ||
    actions.length === 0 ||
    actions.some((action) => !(PAYMENT_ACTIONS as readonly string[]).includes(action))
  ) {
    throw new RarError('payment_initiation requires actions out of initiate, status, cancel');
  }
  const instructedAmount = detail['instructedAmount'];
  if (typeof instructedAmount !== 'object' || instructedAmount === null || Array.isArray(instructedAmount)) {
    throw new RarError('payment_initiation requires an instructedAmount object');
  }
  const { currency, amount } = instructedAmount as Record<string, unknown>;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new RarError('payment_initiation requires an uppercase three-letter currency');
  }
  if (typeof amount !== 'string' || !/^\d+\.\d{2}$/.test(amount)) {
    throw new RarError('payment_initiation requires a decimal amount string');
  }
}

/**
 * payment_initiation の要素から、同意画面に出す固定書式の表示行（アクションごとに 1 行）を返す。
 *
 * `validatePaymentInitiation()` を通った要素だけを受ける前提で、
 * `Initiate a payment of EUR 123.50` のようなプレーン文字列を組み立てる。
 *
 * @spec RFC 9396 §3.1
 */
function describePaymentInitiation(detail: AuthorizationDetail): readonly string[] {
  const { currency, amount } = detail['instructedAmount'] as { currency: string; amount: string };
  const actions = (detail.actions ?? []) as readonly (typeof PAYMENT_ACTIONS)[number][];
  return actions.map((action) => `${ACTION_VERBS[action]} ${currency} ${amount}`);
}

/** The demo type definitions dev-data.ts assigns to rarConfig.types. */
export const demoRarTypes: readonly AuthorizationDetailTypeDefinition[] = [
  {
    type: 'payment_initiation',
    validate: validatePaymentInitiation,
    describe: describePaymentInitiation,
  },
];
