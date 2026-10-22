// Sign-in screen: the user's Atlassian email + API token, checked with Jira, then kept in this browser (see session.ts).
import { loginProblem } from './auth-logic.js';
import { postLogin } from './api.js';
import { signIn, takeLoginNote } from './session.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Shows the sign-in form; `onSignedIn` runs once Jira accepted the credentials (they are stored by then). */
export function setupLogin(onSignedIn: () => void): void {
  const root = $<HTMLElement>('login');
  const form = $<HTMLFormElement>('login-form');
  const email = $<HTMLInputElement>('login-email');
  const token = $<HTMLInputElement>('login-token');
  const remember = $<HTMLInputElement>('login-remember');
  const showToken = $<HTMLInputElement>('login-show');
  const submit = $<HTMLButtonElement>('login-submit');
  const error = $<HTMLParagraphElement>('login-error');
  const note = $<HTMLParagraphElement>('login-note');

  const show = (target: HTMLElement, text: string | undefined) => {
    target.textContent = text ?? '';
    target.hidden = !text;
  };

  root.hidden = false;
  show(note, takeLoginNote());
  email.focus();

  showToken.addEventListener('change', () => {
    token.type = showToken.checked ? 'text' : 'password';
  });

  let busy = false;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    show(error, undefined);
    show(note, undefined);
    const problem = loginProblem(email.value, token.value);
    if (problem) return show(error, problem);
    busy = true;
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    try {
      const who = await postLogin(email.value.trim(), token.value.trim());
      signIn({ email: who.email, token: token.value.trim(), name: who.displayName, accountId: who.accountId, remember: remember.checked });
      token.value = '';
      root.hidden = true;
      onSignedIn();
    } catch (err) {
      show(error, err instanceof Error ? err.message : String(err));
    } finally {
      busy = false;
      submit.disabled = false;
      submit.textContent = 'Sign in';
    }
  });
}
