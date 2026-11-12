/**
 * The steps that check the last response of a scenario, on every target.
 *
 * The phrases are the ones the test catalog uses for the same expectations of
 * the code (`expect(response.status).toBe(401)` reads as `the HTTP status is
 * 401`), so one translation table (ja.yaml) serves both.
 */
import { expect } from '@playwright/test';
import { createBdd } from 'playwright-bdd';
import { jsonBody, lastResponse, test } from '../support/target.js';

const { Then } = createBdd(test);

Then('the HTTP status is {int}', async ({ exchange }, status: number) => {
  expect(lastResponse(exchange).status).toBe(status);
});

// RFC 6749 §5.2: the error parameter of an error response.
Then('the error code is {string}', async ({ exchange }, code: string) => {
  expect(jsonBody(exchange).error).toBe(code);
});

// RFC 6749 §5.2: the error_description parameter of an error response.
Then('the error description is {string}', async ({ exchange }, description: string) => {
  expect(jsonBody(exchange).error_description).toBe(description);
});

Then('the {string} header is {string}', async ({ exchange }, name: string, value: string) => {
  expect(lastResponse(exchange).headers[name.toLowerCase()]).toBe(value);
});

Then('the {string} header starts with {string}', async ({ exchange }, name: string, prefix: string) => {
  expect(lastResponse(exchange).headers[name.toLowerCase()]).toMatch(new RegExp(`^${escapeRegExp(prefix)}`));
});

Then('the body has {word} {string}', async ({ exchange }, name: string, value: string) => {
  expect(jsonBody(exchange)[name]).toBe(value);
});

Then('the body has {word} {int}', async ({ exchange }, name: string, value: number) => {
  expect(jsonBody(exchange)[name]).toBe(value);
});

// A member whose value the scenario cannot fix (a token): a string that is not empty.
Then('the body has a(n) {word}', async ({ exchange }, name: string) => {
  const value = jsonBody(exchange)[name];
  expect(typeof value).toBe('string');
  expect(value).not.toBe('');
});

// A member the response must not carry (a refresh_token or an id_token of a grant that issues none).
Then('the body has no {word}', async ({ exchange }, name: string) => {
  expect(jsonBody(exchange)).not.toHaveProperty(name);
});

Then('the length of {word} is {int}', async ({ exchange }, name: string, length: number) => {
  expect(jsonBody(exchange)[name]).toHaveLength(length);
});

/** The text with the characters a regular expression reads as syntax escaped. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
