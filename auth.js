// Spotify Authorization Code with PKCE. No client secret, no backend.
const AUTHORIZE_ENDPOINT = 'https://accounts.spotify.com/authorize';
const TOKEN_ENDPOINT = 'https://accounts.spotify.com/api/token';

const VERIFIER_KEY = 'kmt_pkce_verifier';
const STATE_KEY = 'kmt_pkce_state';
const TOKENS_KEY = 'kmt_tokens';

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

function readJson(storage, key) {
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error(`Failed to read ${key} from storage`, e);
    return null;
  }
}

function writeJson(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch (e) {
    console.error(`Failed to write ${key} to storage`, e);
  }
}

export function loadTokens() {
  return readJson(localStorage, TOKENS_KEY);
}

export function clearTokens() {
  try {
    localStorage.removeItem(TOKENS_KEY);
  } catch (e) {
    console.error('Failed to clear tokens', e);
  }
}

function saveTokens(record) {
  writeJson(localStorage, TOKENS_KEY, record);
}

export async function redirectToLogin(config) {
  const verifier = randomToken(64);
  const state = randomToken(16);
  try {
    sessionStorage.setItem(VERIFIER_KEY, verifier);
    sessionStorage.setItem(STATE_KEY, state);
  } catch (e) {
    throw new Error('Could not use sessionStorage for the PKCE verifier: ' + e.message);
  }

  const challenge = await sha256Base64Url(verifier);
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: config.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    scope: config.scopes.join(' '),
    state,
    // Without this, Spotify can silently reuse whatever was approved the
    // first time this app was ever authorized and skip the approval
    // screen entirely — which would mean a scope added to config.js later
    // never actually reaches the user, even after "Log in again", with no
    // visible sign that's what happened.
    show_dialog: 'true',
  });
  window.location.assign(`${AUTHORIZE_ENDPOINT}?${params.toString()}`);
}

/** Returns true if a redirect callback (?code=...) was handled. */
export async function handleRedirectCallback(config) {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');
  const returnedState = url.searchParams.get('state');

  if (!code && !error) return false;

  if (error) {
    window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    throw new Error(`Spotify authorization returned an error: ${error}`);
  }

  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);

  if (!verifier || !expectedState) {
    throw new Error('Missing PKCE verifier/state (session storage was cleared) — please log in again.');
  }
  if (returnedState !== expectedState) {
    throw new Error('State mismatch on redirect — possible CSRF, aborting login.');
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(STATE_KEY);

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const tokens = await res.json();
  saveTokens({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope,
    // Refreshing the access token later does NOT reset the refresh token's
    // ~6-month lifetime, which is measured from this original login — kept
    // unchanged across refreshes so the account panel can warn accurately.
    authorized_at: Date.now(),
  });
  return true;
}

export async function refreshAccessToken(config) {
  const current = loadTokens();
  if (!current || !current.refresh_token) {
    throw new Error('REAUTH_REQUIRED');
  }

  const body = new URLSearchParams({
    client_id: config.clientId,
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    if (res.status === 400) {
      // invalid_grant: refresh token expired (~6 months from original login) or revoked.
      clearTokens();
      throw new Error('REAUTH_REQUIRED');
    }
    const text = await res.text().catch(() => '');
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const tokens = await res.json();
  const merged = {
    access_token: tokens.access_token,
    // Spotify may rotate the refresh token or omit it; keep the old one if omitted.
    refresh_token: tokens.refresh_token || current.refresh_token,
    expires_at: Date.now() + tokens.expires_in * 1000,
    scope: tokens.scope || current.scope,
    authorized_at: current.authorized_at || Date.now(),
  };
  saveTokens(merged);
  return merged;
}

export async function getValidAccessToken(config, { thresholdMs = 60_000 } = {}) {
  const tokens = loadTokens();
  if (!tokens) return null;
  if (tokens.expires_at - Date.now() > thresholdMs) {
    return tokens.access_token;
  }
  const refreshed = await refreshAccessToken(config);
  return refreshed.access_token;
}

// Spotify states the refresh token lifetime as "~6 months" without an exact
// day count, so this is an estimate for a plain-language warning, not an
// authoritative expiry.
const ESTIMATED_REFRESH_TOKEN_LIFETIME_DAYS = 180;
const WARN_WITHIN_DAYS = 14;

export function getLoginAgeInfo() {
  const tokens = loadTokens();
  if (!tokens || !tokens.authorized_at) return null;
  const ageDays = (Date.now() - tokens.authorized_at) / (24 * 60 * 60 * 1000);
  const daysRemaining = Math.round(ESTIMATED_REFRESH_TOKEN_LIFETIME_DAYS - ageDays);
  return { daysRemaining, expiringSoon: daysRemaining <= WARN_WITHIN_DAYS };
}
