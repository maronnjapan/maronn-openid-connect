/** What a browser holds between two requests of a grant: its cookies, by name. */
export type CookieJar = Map<string, string>;

/** Keep the cookies a response sets, and forget those it clears (an empty value, or Max-Age=0). */
export function keepCookies(jar: CookieJar, setCookies: readonly string[]): void {
  for (const cookie of setCookies) {
    const [pair = ''] = cookie.split(';');
    const equals = pair.indexOf('=');
    if (equals <= 0) continue;
    const name = pair.slice(0, equals).trim();
    const value = pair.slice(equals + 1).trim();
    if (value === '' || /;\s*max-age=0\s*(;|$)/i.test(cookie)) jar.delete(name);
    else jar.set(name, value);
  }
}

/** The Cookie header a browser carries on its next same-origin request. */
export function cookieHeaders(jar: CookieJar): Array<[string, string]> {
  return jar.size === 0 ? [] : [['cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; ')]];
}

/** A character reference of HTML made again (`&amp;` → `&`): the OP escapes `&`, `<`, `>` and the quotes in the values of its pages. */
function unescapeHtml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[name] ?? '');
}

/** The value of an attribute of an HTML tag; undefined without it. */
function attributeOf(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match === null ? undefined : unescapeHtml(match[1] ?? '');
}

/**
 * The form of an OP's page as a user submits it: where it posts, and its
 * fields, the hidden ones as they are, the text and password inputs with
 * the user's name and password, and the submit button that approves (the
 * first one when none does). Undefined for a page without a form that posts.
 */
export function submittedForm(html: string, user: { username: string; password: string }): { action: string; fields: Array<[string, string]> } | undefined {
  const form = /<form\b[^>]*>/i.exec(html)?.[0];
  if (form === undefined || (attributeOf(form, 'method') ?? '').toLowerCase() !== 'post') return undefined;
  const fields: Array<[string, string]> = [];
  for (const [input] of html.matchAll(/<input\b[^>]*>/gi)) {
    const name = attributeOf(input, 'name');
    if (name === undefined) continue;
    const type = (attributeOf(input, 'type') ?? 'text').toLowerCase();
    if (type === 'hidden') fields.push([name, attributeOf(input, 'value') ?? '']);
    else if (type === 'password') fields.push([name, user.password]);
    else if (type === 'text') fields.push([name, user.username]);
  }
  const buttons = [...html.matchAll(/<button\b[^>]*>/gi)].map(([tag]) => tag).filter((tag) => (attributeOf(tag, 'type') ?? 'submit') === 'submit' && attributeOf(tag, 'name') !== undefined);
  const button = buttons.find((tag) => attributeOf(tag, 'value') === 'approve') ?? buttons[0];
  if (button !== undefined) fields.push([attributeOf(button, 'name') ?? '', attributeOf(button, 'value') ?? '']);
  return { action: attributeOf(form, 'action') ?? '', fields };
}
