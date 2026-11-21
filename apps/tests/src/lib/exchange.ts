/**
 * A request a measured API test sent and the response it got (CaseExample
 * of the cases file) as the lines the page shows, in the style of the
 * examples of the RFCs:
 *
 *     POST /token HTTP/1.1
 *     Host: op.example.com
 *     Authorization: Basic Y2xpZW50LTE6Y2xpZW50LTEtc2VjcmV0LXZhbHVl
 *     Content-Type: application/x-www-form-urlencoded
 *
 *     grant_type=authorization_code
 *     &code=code-1
 *
 * A form body or a query is one parameter a line, its values percent-decoded
 * for reading; a JSON body is pretty-printed; the Location of a redirect has
 * its query one parameter a line. A long token is shortened in the middle,
 * its whole value one toggle away, and a JWT is decoded (never verified) so
 * its header and payload can be read. The decoded `client_id:secret` of a
 * Basic Authorization header is a note under it. Nothing here touches the
 * DOM or fetches.
 */
import type { CaseExample, ExampleRequest, ExampleResponse } from '@maronn-openid-connect/test-catalog/model';

/** How a piece of a line is colored: the start line, a header name, a parameter or a JSON key, a JSON value, punctuation, a quiet note. */
export type Tone = 'start' | 'name' | 'key' | 'string' | 'literal' | 'punct' | 'muted';

/** The header and the payload of a JWT, decoded without verifying its signature; the payload is absent when it is no JSON. */
export interface DecodedJwt {
  header: Record<string, unknown>;
  payload?: unknown;
}

/**
 * A piece of a line: some text, or a long value shown shortened in the
 * middle (`head…tail`) whose whole text, and for a JWT its decoded header
 * and payload, the reader can open. `id` tells the long values of a block
 * apart.
 */
export type Piece = { kind: 'text'; text: string; tone?: Tone } | { kind: 'long'; id: string; text: string; head: string; tail: string; jwt?: DecodedJwt; tone?: Tone };

/** A line of a block, with a note in words under it (the decoded credentials of Basic). */
export interface HttpLine {
  pieces: Piece[];
  note?: string;
}

/** How a body is shown. */
export type BodyKind = 'form' | 'json' | 'jwt' | 'text';

/** A request or a response as the page shows it: the start line and the headers, the body after a blank line, and notes under it. */
export interface HttpBlock {
  head: HttpLine[];
  body: HttpLine[];
  bodyKind?: BodyKind;
  /** What the reader should know about how the block is shown: values decoded for reading, a body cut short. */
  notes: string[];
}

/** A value without spaces this long or longer is shortened in the middle (a JWT is always, being long). */
export const LONG = 64;

/** How many characters of a shortened value show before and after the `…`. */
const HEAD = 20;
const TAIL = 8;

/** The claims of a JWT that are times (seconds since the epoch), shown with their date. */
const TIME_CLAIMS = new Set(['iat', 'exp', 'nbf', 'auth_time', 'updated_at']);

/** The reason phrases of the statuses an OP answers with, for a response recorded without one. */
const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  409: 'Conflict',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/** The words of the notes under a block. */
export const DECODED_NOTE = 'フォームとクエリの値は、読みやすいようにパーセントデコードしています。';
export const TRUNCATED_NOTE = 'ボディは 16 KiB で切っています。';

/** The reason phrase of a status: the recorded one, else the one of HTTP; empty for a status the table does not know. */
export function reasonPhrase(status: number, statusText?: string): string {
  if (statusText !== undefined && statusText.trim() !== '') return statusText;
  return REASONS[status] ?? '';
}

/** A header name as the RFCs write it (`content-type` → `Content-Type`, `www-authenticate` → `WWW-Authenticate`, `dpop` → `DPoP`). */
export function headerName(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'dpop') return 'DPoP';
  if (lower === 'www-authenticate') return 'WWW-Authenticate';
  if (lower === 'etag') return 'ETag';
  return lower.replace(/(^|-)([a-z])/g, (_, dash: string, letter: string) => `${dash}${letter.toUpperCase()}`);
}

/** Percent-decode a value of a form or a query (`+` is a space), keeping it as it is when it is no valid encoding. */
export function formDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/** The bytes of a base64url (or base64) text as UTF-8 text; undefined when it is neither. */
function base64UrlText(text: string): string | undefined {
  if (!/^[A-Za-z0-9_\-+/]*={0,2}$/.test(text)) return undefined;
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (base64.length % 4 === 1) return undefined;
  try {
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** A text parsed as JSON; undefined when it is none. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether a value is a plain object (a JSON object). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The header and the payload of a JWS in its compact serialization,
 * decoded without verifying it: undefined for a text that is no JWT (not
 * three base64url parts, or a header that is no JSON object).
 */
export function decodeJwt(text: string): DecodedJwt | undefined {
  const parts = text.split('.');
  if (parts.length !== 3 || !text.startsWith('eyJ')) return undefined;
  const [first = '', second = ''] = parts;
  const headerText = base64UrlText(first);
  const header = headerText === undefined ? undefined : parseJson(headerText);
  if (!isObject(header)) return undefined;
  const payloadText = base64UrlText(second);
  const payload = payloadText === undefined ? undefined : parseJson(payloadText);
  return payload === undefined ? { header } : { header, payload };
}

/**
 * The `client_id:client_secret` of a Basic Authorization header (RFC 6749
 * §2.3.1 form-encodes both before base64), decoded; undefined for another
 * scheme or a value that does not decode.
 */
export function basicCredentials(value: string): string | undefined {
  const match = /^Basic\s+(\S+)$/i.exec(value.trim());
  if (match === null) return undefined;
  const text = base64UrlText(match[1] as string);
  if (text === undefined || !text.includes(':')) return undefined;
  const colon = text.indexOf(':');
  return `${formDecode(text.slice(0, colon))}:${formDecode(text.slice(colon + 1))}`;
}

/** The two ends of a value shortened in the middle, or undefined for a value short enough to show whole. */
export function shorten(text: string, jwt = false): { head: string; tail: string } | undefined {
  if (/\s/.test(text)) return undefined;
  if (!jwt && (text.length < LONG || /^[a-z][a-z0-9+.-]*:\/\//i.test(text))) return undefined;
  if (text.length <= HEAD + TAIL + 4) return undefined;
  return { head: text.slice(0, HEAD), tail: text.slice(-TAIL) };
}

/** A value as pieces: a long one shortened in the middle (a JWT with its decoded parts), else its text. */
export function valuePieces(text: string, id: string, tone?: Tone): Piece[] {
  const jwt = decodeJwt(text);
  const ends = shorten(text, jwt !== undefined);
  if (ends === undefined) return [{ kind: 'text', text, ...(tone === undefined ? {} : { tone }) }];
  return [{ kind: 'long', id, text, head: ends.head, tail: ends.tail, ...(jwt === undefined ? {} : { jwt }), ...(tone === undefined ? {} : { tone }) }];
}

/** A text piece. */
function text(value: string, tone?: Tone): Piece {
  return tone === undefined ? { kind: 'text', text: value } : { kind: 'text', text: value, tone };
}

/** The parameters of a form body or a query, each with its name and value decoded, and whether decoding changed any. */
export function formParams(body: string): { params: Array<[string, string]>; decoded: boolean } {
  let decoded = false;
  const params: Array<[string, string]> = [];
  for (const pair of body.split('&')) {
    if (pair === '') continue;
    const equals = pair.indexOf('=');
    const rawName = equals === -1 ? pair : pair.slice(0, equals);
    const rawValue = equals === -1 ? '' : pair.slice(equals + 1);
    const name = formDecode(rawName);
    const value = formDecode(rawValue);
    if (name !== rawName || value !== rawValue) decoded = true;
    params.push([name, value]);
  }
  return { params, decoded };
}

/** The lines of some parameters, one a line: the first after `first` (`?`, or nothing for a form body), the others after `&`, each indented by `indent`. */
function paramLines(params: ReadonlyArray<[string, string]>, idPrefix: string, first: string, indent: string): HttpLine[] {
  return params.map(([name, value], index) => ({
    pieces: [text(`${indent}${index === 0 ? first : '&'}`, 'punct'), text(name, 'key'), text('=', 'punct'), ...valuePieces(value, `${idPrefix}.${index}`, 'string')],
  }));
}

/** The lines of a form body (`application/x-www-form-urlencoded`), one parameter a line; `decoded` when a value read differently from what was sent. */
export function formLines(body: string, idPrefix = 'form'): { lines: HttpLine[]; decoded: boolean } {
  const { params, decoded } = formParams(body);
  return { lines: paramLines(params, idPrefix, '', ''), decoded };
}

/** A JSON primitive as a piece: a string quoted (a long one shortened), a number, a boolean or null as a literal. */
function primitivePieces(value: unknown, id: string): Piece[] {
  if (typeof value === 'string') {
    const pieces = valuePieces(value, id, 'string');
    // A long value keeps its quotes around the shortened text.
    return pieces.flatMap((piece) => (piece.kind === 'text' ? [text(JSON.stringify(piece.text), 'string')] : [text('"', 'string'), piece, text('"', 'string')]));
  }
  return [text(JSON.stringify(value) ?? 'null', 'literal')];
}

/** Whether an array is short enough to stay on one line: primitives only, and few characters. */
function inlineArray(value: readonly unknown[]): boolean {
  return value.every((item) => typeof item !== 'object' || item === null) && JSON.stringify(value).length <= 60 && !value.some((item) => typeof item === 'string' && decodeJwt(item) !== undefined);
}

/** The date of a time claim (seconds since the epoch), as UTC; undefined for a number that is none. */
export function claimDate(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 1e11) return undefined;
  return new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * Pretty-print a JSON value as lines, two spaces a level, a long string
 * shortened in the middle; with `times`, a time claim (iat, exp, …) of the
 * top level has its date beside it.
 */
export function jsonLines(value: unknown, idPrefix = 'json', times = false): HttpLine[] {
  const lines: HttpLine[] = [];
  /** Add the lines of a value at a depth, after its key (when in an object), with a comma when another item follows. */
  function add(item: unknown, depth: number, key: string | undefined, comma: boolean, id: string): void {
    const indent = '  '.repeat(depth);
    const lead: Piece[] = [text(indent)];
    if (key !== undefined) lead.push(text(JSON.stringify(key), 'key'), text(': ', 'punct'));
    const tail = comma ? [text(',', 'punct')] : [];
    if (Array.isArray(item)) {
      if (item.length === 0 || inlineArray(item)) {
        const inner: Piece[] = [];
        item.forEach((element, index) => {
          if (index > 0) inner.push(text(', ', 'punct'));
          inner.push(...primitivePieces(element, `${id}.${index}`));
        });
        lines.push({ pieces: [...lead, text('[', 'punct'), ...inner, text(']', 'punct'), ...tail] });
        return;
      }
      lines.push({ pieces: [...lead, text('[', 'punct')] });
      item.forEach((element, index) => add(element, depth + 1, undefined, index < item.length - 1, `${id}.${index}`));
      lines.push({ pieces: [text(indent), text(']', 'punct'), ...tail] });
      return;
    }
    if (isObject(item)) {
      const entries = Object.entries(item);
      if (entries.length === 0) {
        lines.push({ pieces: [...lead, text('{}', 'punct'), ...tail] });
        return;
      }
      lines.push({ pieces: [...lead, text('{', 'punct')] });
      entries.forEach(([name, element], index) => add(element, depth + 1, name, index < entries.length - 1, `${id}.${name}`));
      lines.push({ pieces: [text(indent), text('}', 'punct'), ...tail] });
      return;
    }
    const date = times && depth === 1 && key !== undefined && TIME_CLAIMS.has(key) && typeof item === 'number' ? claimDate(item) : undefined;
    lines.push({ pieces: [...lead, ...primitivePieces(item, id), ...tail, ...(date === undefined ? [] : [text(`  // ${date}`, 'muted')])] });
  }
  add(value, 0, undefined, false, idPrefix);
  return lines;
}

/** The value of a header of a list (the first with the name, case-insensitive). */
export function headerValue(headers: ReadonlyArray<[string, string]>, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([candidate]) => candidate.toLowerCase() === lower)?.[1];
}

/** The media type of a Content-Type, lower-cased and without its parameters (`application/json; charset=utf-8` → `application/json`). */
function mediaType(headers: ReadonlyArray<[string, string]>): string | undefined {
  const value = headerValue(headers, 'content-type');
  return value?.split(';')[0]?.trim().toLowerCase();
}

/** Whether a text reads as a form body: name=value pairs joined by `&`, no spaces. */
function looksLikeForm(body: string): boolean {
  return /^[\w.~%+*-]+=[^&\s]*(?:&[\w.~%+*-]+=[^&\s]*)*$/.test(body);
}

/** How a body is shown, by its Content-Type, else by what it reads as. */
export function bodyKind(headers: ReadonlyArray<[string, string]>, body: string, truncated = false): BodyKind {
  const type = mediaType(headers);
  const json = truncated ? undefined : parseJson(body);
  if (type === 'application/x-www-form-urlencoded') return 'form';
  if ((type === 'application/json' || type?.endsWith('+json') === true) && json !== undefined) return 'json';
  if ((type === 'application/jwt' || type?.endsWith('+jwt') === true) && decodeJwt(body.trim()) !== undefined) return 'jwt';
  if (type === undefined) {
    if (json !== undefined && typeof json === 'object' && json !== null) return 'json';
    if (decodeJwt(body.trim()) !== undefined) return 'jwt';
    if (looksLikeForm(body)) return 'form';
  }
  return 'text';
}

/** The lines of a body by its kind, and whether a value of it reads decoded. */
function bodyLines(kind: BodyKind, body: string): { lines: HttpLine[]; decoded: boolean } {
  if (kind === 'form') return formLines(body, 'body');
  if (kind === 'json') return { lines: jsonLines(parseJson(body), 'body'), decoded: false };
  if (kind === 'jwt') return { lines: [{ pieces: valuePieces(body.trim(), 'body', 'string') }], decoded: false };
  return { lines: body.split(/\r?\n/).map((line) => ({ pieces: [text(line)] })), decoded: false };
}

/** The pieces of a header value: an Authorization (or DPoP) token shortened after its scheme, a long value shortened, else its text. */
function headerValuePieces(name: string, value: string, id: string): Piece[] {
  const lower = name.toLowerCase();
  if (lower === 'authorization' || lower === 'proxy-authorization') {
    const match = /^(\S+)(\s+)(\S+)$/.exec(value);
    // Basic is shown as sent: its decoded credentials are a note under it.
    if (match !== null && (match[1] as string).toLowerCase() !== 'basic') return [text(`${match[1]}${match[2]}`), ...valuePieces(match[3] as string, id)];
    return [text(value)];
  }
  return valuePieces(value, id);
}

/** The line of a header: its name as the RFCs write it, its value, and for Basic the decoded credentials as a note. */
function headerLine(name: string, value: string, id: string): HttpLine {
  const credentials = name.toLowerCase() === 'authorization' ? basicCredentials(value) : undefined;
  return {
    pieces: [text(headerName(name), 'name'), text(': ', 'punct'), ...headerValuePieces(name, value, id)],
    ...(credentials === undefined ? {} : { note: `client_id:client_secret をデコードすると ${credentials}` }),
  };
}

/**
 * The lines of a URL with its query (and fragment) one parameter a line,
 * after `lead` (`Location: `, or the method of a request): the base on the
 * first line, `?first` under it and `&next` under that, indented; `end` is
 * added to the last line (` HTTP/1.1`).
 */
function urlLines(lead: Piece[], url: string, idPrefix: string, end: Piece[] = []): { lines: HttpLine[]; decoded: boolean } {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const fragment = hashAt === -1 ? undefined : url.slice(hashAt + 1);
  const queryAt = beforeHash.indexOf('?');
  const base = queryAt === -1 ? beforeHash : beforeHash.slice(0, queryAt);
  const query = queryAt === -1 ? undefined : beforeHash.slice(queryAt + 1);
  const lines: HttpLine[] = [{ pieces: [...lead, text(base)] }];
  let decoded = false;
  for (const [mark, part] of [['?', query], ['#', fragment]] as const) {
    if (part === undefined || part === '') continue;
    const read = formParams(part);
    decoded ||= read.decoded;
    lines.push(...paramLines(read.params, `${idPrefix}${mark === '?' ? '.query' : '.fragment'}`, mark, '    '));
  }
  const last = lines[lines.length - 1] as HttpLine;
  last.pieces.push(...end);
  return { lines, decoded };
}

/** The notes of a block: the values read decoded, the body cut short. */
function notesOf(decoded: boolean, truncated: boolean | undefined): string[] {
  return [...(decoded ? [DECODED_NOTE] : []), ...(truncated === true ? [TRUNCATED_NOTE] : [])];
}

/**
 * A request as the RFCs show one: `POST /token HTTP/1.1`, `Host:`, the
 * headers as sent (names as the RFCs write them), and after a blank line its
 * body. A query of several parameters is one parameter a line under the
 * path.
 */
export function requestBlock(request: ExampleRequest): HttpBlock {
  const start: Piece[] = [text(`${request.method} `, 'start')];
  const version = [text(' HTTP/1.1', 'start')];
  const target = request.path.includes('?') && formParams(request.path.slice(request.path.indexOf('?') + 1)).params.length > 1 ? urlLines(start, request.path, 'path', version) : { lines: [{ pieces: [...start, text(request.path), ...version] }], decoded: false };
  const head: HttpLine[] = [...target.lines, headerLine('host', request.host, 'header.host')];
  request.headers.forEach(([name, value], index) => {
    if (name.toLowerCase() !== 'host') head.push(headerLine(name, value, `header.${index}`));
  });
  const kind = request.body === undefined || request.body === '' ? undefined : bodyKind(request.headers, request.body, request.truncated === true);
  const body = kind === undefined ? { lines: [], decoded: false } : bodyLines(kind, request.body as string);
  return { head, body: body.lines, ...(kind === undefined ? {} : { bodyKind: kind }), notes: notesOf(target.decoded || body.decoded, request.truncated) };
}

/** A response as the RFCs show one: `HTTP/1.1 200 OK`, its headers (a Location with its query one parameter a line), and its body. */
export function responseBlock(response: ExampleResponse): HttpBlock {
  const reason = reasonPhrase(response.status, response.statusText);
  const head: HttpLine[] = [{ pieces: [text(`HTTP/1.1 ${response.status}${reason === '' ? '' : ` ${reason}`}`, 'start')] }];
  let decoded = false;
  response.headers.forEach(([name, value], index) => {
    if (name.toLowerCase() === 'location' && /[?#]/.test(value)) {
      const location = urlLines([text(headerName(name), 'name'), text(': ', 'punct')], value, `header.${index}`);
      decoded ||= location.decoded;
      head.push(...location.lines);
    } else {
      head.push(headerLine(name, value, `header.${index}`));
    }
  });
  const kind = response.body === undefined || response.body === '' ? undefined : bodyKind(response.headers, response.body, response.truncated === true);
  const body = kind === undefined ? { lines: [], decoded: false } : bodyLines(kind, response.body as string);
  return { head, body: body.lines, ...(kind === undefined ? {} : { bodyKind: kind }), notes: notesOf(decoded || body.decoded, response.truncated) };
}

/** What a status says, for its color and its words: an answer, a redirect, or an error. */
export type StatusTone = 'ok' | 'redirect' | 'error';

/** The tone of a status: 2xx an answer, 3xx a redirect, else an error. */
export function statusTone(status: number): StatusTone {
  if (status >= 200 && status < 300) return 'ok';
  if (status >= 300 && status < 400) return 'redirect';
  return 'error';
}

/**
 * The OAuth error a response carries (RFC 6749 §5.2, §4.1.2.1, RFC 6750
 * §3): the `error` of a JSON body, else of the query or the fragment of its
 * Location, else of its WWW-Authenticate; undefined for none.
 */
export function errorCodeOf(response: ExampleResponse): string | undefined {
  if (response.body !== undefined && response.truncated !== true) {
    const json = parseJson(response.body);
    if (isObject(json) && typeof json.error === 'string') return json.error;
  }
  const location = headerValue(response.headers, 'location');
  if (location !== undefined) {
    for (const part of location.split(/[?#]/).slice(1)) {
      const found = formParams(part).params.find(([name]) => name === 'error');
      if (found !== undefined) return found[1];
    }
  }
  const challenge = headerValue(response.headers, 'www-authenticate');
  const match = challenge === undefined ? null : /\berror="([^"]*)"/.exec(challenge);
  return match === null ? undefined : match[1];
}

/** A value of a preview, shortened to a few characters. */
function previewValue(value: string): string {
  return value.length > 32 ? `${value.slice(0, 24)}…` : value;
}

/**
 * The first parameter that tells requests of an endpoint apart, for a
 * one-line preview: `grant_type` of a form body when it has one, else its
 * first parameter, else the first of the query.
 */
function keyParam(request: ExampleRequest): [string, string] | undefined {
  const form = request.body !== undefined && request.body !== '' && bodyKind(request.headers, request.body, request.truncated === true) === 'form' ? formParams(request.body).params : [];
  const query = request.path.includes('?') ? formParams(request.path.slice(request.path.indexOf('?') + 1)).params : [];
  for (const params of [form, query]) {
    const preferred = params.find(([name]) => name === 'grant_type' || name === 'response_type');
    if (preferred !== undefined) return preferred;
    if (params[0] !== undefined) return params[0];
  }
  return undefined;
}

/** A request and its answer in one line, for the list of the cases: `POST /token · grant_type=refresh_token → 200`. */
export function previewOf(example: Pick<CaseExample, 'request' | 'response'>): string {
  const { request, response } = example;
  const path = request.path.split('?')[0] ?? request.path;
  const param = keyParam(request);
  return `${request.method} ${path}${param === undefined ? '' : ` · ${param[0]}=${previewValue(param[1])}`} → ${response.status}`;
}

/** The text of a line as it would be copied: its pieces, a long value whole. */
export function lineText(line: HttpLine): string {
  return line.pieces.map((piece) => piece.text).join('');
}
