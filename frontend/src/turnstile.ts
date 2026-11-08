// Cloudflare Turnstile -> backend ticket. The data API rejects requests without a
// ticket (egress cost guard), so every data/export call goes through getTicket().

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';
// Local dev default is Cloudflare's always-pass test sitekey (pair with the test secret on the backend).
const SITEKEY = import.meta.env.VITE_TURNSTILE_SITEKEY || '1x00000000000000000000AA';
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

declare global {
  interface Window {
    turnstile?: {
      render(el: HTMLElement, opts: Record<string, unknown>): string;
      remove(id: string): void;
    };
  }
}

let ticket = '';
let expiresAt = 0;
let pending: Promise<string> | null = null;
let scriptLoad: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  return (scriptLoad ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT_URL;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      scriptLoad = null;
      reject(new Error('Turnstile 스크립트 로드 실패'));
    };
    document.head.appendChild(s);
  }));
}

// Widget renders into a fixed overlay; with appearance 'interaction-only' it stays
// invisible unless Cloudflare decides the visitor must click.
function solveChallenge(): Promise<string> {
  return new Promise((resolve, reject) => {
    const box = document.createElement('div');
    box.className = 'turnstile-box';
    document.body.appendChild(box);
    let id = '';
    const done = () => {
      if (id) window.turnstile!.remove(id);
      box.remove();
    };
    id = window.turnstile!.render(box, {
      sitekey: SITEKEY,
      action: 'turnstile-spin-v1',
      appearance: 'interaction-only',
      callback: (token: string) => {
        done();
        resolve(token);
      },
      'error-callback': () => {
        done();
        reject(new Error('사람 확인 실패'));
      },
    });
  });
}

async function fetchTicket(): Promise<string> {
  await loadScript();
  const token = await solveChallenge();
  const res = await fetch(`${API_BASE}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) throw new Error(`세션 발급 실패 (HTTP ${res.status})`);
  const data: { ticket: string; expires_in: number } = await res.json();
  ticket = data.ticket;
  expiresAt = Date.now() + (data.expires_in - 60) * 1000; // renew 1 min early
  return ticket;
}

/** Cached ticket, or run the Turnstile check once (concurrent callers share it). */
export function getTicket(): Promise<string> {
  if (ticket && Date.now() < expiresAt) return Promise.resolve(ticket);
  return (pending ||= fetchTicket().finally(() => (pending = null)));
}

/** Server rejected the ticket (e.g. instance restarted): force a new check next time. */
export function dropTicket() {
  ticket = '';
  expiresAt = 0;
}
