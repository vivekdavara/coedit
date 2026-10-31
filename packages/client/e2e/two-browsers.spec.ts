// Two people, each in their own browser (separate contexts: no shared storage), editing one document at once through
// the real sync server and dev server, offline and back. Each test uses a document of its own.
import { expect, test, type Browser, type Page } from '@playwright/test';

let docs = 0;
const freshDoc = () => `e2e-${Date.now().toString(36)}-${++docs}`;

/** Opens `doc` in a new browser context and waits until it's online. */
async function person(browser: Browser, doc: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/?doc=${doc}`);
  await expect(page.getByText(`${doc} · online`)).toBeVisible();
  return page;
}

const editor = (page: Page) => page.getByRole('textbox', { name: 'Document' });

test('what one types, the other sees, both ways', async ({ browser }) => {
  const doc = freshDoc();
  const a = await person(browser, doc);
  const b = await person(browser, doc);
  await editor(a).click();
  await a.keyboard.type('hello from a');
  await expect(editor(b)).toHaveValue('hello from a');
  await editor(b).click();
  await b.keyboard.press('End');
  await b.keyboard.type(', and b');
  await expect(editor(a)).toHaveValue('hello from a, and b');
  // Each sees the other here, and the other's caret.
  await expect(a.getByText('1 other here')).toBeVisible();
  await expect(a.locator('.remote-caret')).toHaveCount(1);
});

test('typing at the same time converges, each run whole', async ({ browser }) => {
  const doc = freshDoc();
  const a = await person(browser, doc);
  const b = await person(browser, doc);
  await editor(a).click();
  await a.keyboard.type('[]');
  await expect(editor(b)).toHaveValue('[]');
  // Both carets between the brackets, then both type at once.
  for (const page of [a, b]) {
    await editor(page).click();
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowLeft');
  }
  await Promise.all([a.keyboard.type('aaaaaaaaaa'), b.keyboard.type('bbbbbbbbbb')]);
  await expect(editor(a)).toHaveValue(/^\[[ab]{20}\]$/);
  const text = await editor(a).inputValue();
  await expect(editor(b)).toHaveValue(text);
  // RGA keeps each person's run of forward typing together: one run then the other.
  expect(['[aaaaaaaaaabbbbbbbbbb]', '[bbbbbbbbbbaaaaaaaaaa]']).toContain(text);
});

test('offline edits on both sides merge when one comes back', async ({ browser }) => {
  const doc = freshDoc();
  const a = await person(browser, doc);
  const b = await person(browser, doc);
  await editor(a).click();
  await a.keyboard.type('shared ');
  await expect(editor(b)).toHaveValue('shared ');

  await b.getByRole('button', { name: 'Go offline' }).click();
  await expect(b.getByText(`${doc} · offline (by choice)`)).toBeVisible();
  await editor(b).click();
  await b.keyboard.press('End');
  await b.keyboard.type('offline-b');
  // One edit a keystroke: 9 of them waiting.
  await expect(b.getByText('9 edits not yet acknowledged')).toBeVisible();
  await editor(a).click();
  await a.keyboard.press('Home');
  await a.keyboard.type('online-a ');
  await expect(editor(b)).toHaveValue('shared offline-b', { timeout: 1_000 });

  await b.getByRole('button', { name: 'Go online' }).click();
  await expect(b.getByText(`${doc} · online`)).toBeVisible();
  await expect(editor(a)).toHaveValue('online-a shared offline-b');
  await expect(editor(b)).toHaveValue('online-a shared offline-b');
  await expect(b.getByText('not yet acknowledged')).toHaveCount(0);
});

test('a document is still there for someone who opens it after everyone left', async ({
  browser,
}) => {
  const doc = freshDoc();
  const a = await person(browser, doc);
  await editor(a).click();
  await a.keyboard.type('still here');
  await expect(a.getByText('not yet acknowledged')).toHaveCount(0);
  await a.context().close();
  const later = await person(browser, doc);
  await expect(editor(later)).toHaveValue('still here');
});
