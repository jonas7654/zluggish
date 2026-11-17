// SPIKE: checks whether the game launcher's browser can complete an external OIDC sign-in.
// Enabled only with ZLUGGISH_OIDC_SPIKE=1. It signs nobody in and is not meant to be merged.
import type { HttpRuntime as Runtime, RuntimeEnv } from '#src/http/runtime';
import { CryptoRepository } from '#src/repositories/crypto.repository';
import type { Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';

export const oidcSpikeEnabled = () => process.env.ZLUGGISH_OIDC_SPIKE === '1';

// Duende's public demo: any redirect URI, public client with PKCE, sign in as bob/bob or alice/alice.
const provider = {
  issuer: process.env.ZLUGGISH_OIDC_SPIKE_ISSUER ?? 'https://demo.duendesoftware.com',
  clientId: process.env.ZLUGGISH_OIDC_SPIKE_CLIENT_ID ?? 'interactive.public',
  clientSecret: process.env.ZLUGGISH_OIDC_SPIKE_CLIENT_SECRET ?? null,
  scope: process.env.ZLUGGISH_OIDC_SPIKE_SCOPE ?? 'openid profile email',
};

const discoverySchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

interface Pending {
  browserId: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  mode: string;
  created: number;
}

const escape = (value: string) => value.replaceAll(/[&<>"']/g, (char) => `&#${char.codePointAt(0)};`);

type Check = [label: string, ok: boolean | null, detail: string];

const tokenSchema = z.object({ id_token: z.string().optional() }).loose();

const claimsSchema = z
  .object({
    iss: z.string(),
    sub: z.string(),
    aud: z.union([z.string(), z.array(z.string())]),
    exp: z.number(),
    nonce: z.string().optional(),
    auth_time: z.number().optional(),
    name: z.string().optional(),
    email: z.string().optional(),
    preferred_username: z.string().optional(),
  })
  .loose();

function page(title: string, body: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>
body{font:16px/1.5 system-ui,sans-serif;background:#1a2432;color:#eef2f6;margin:0;padding:24px;max-width:760px}
a.button,button{display:inline-block;margin:4px 8px 4px 0;padding:10px 16px;border-radius:999px;border:1px solid #fc6719;background:none;color:#fff;font:inherit;text-decoration:none;cursor:pointer}
a.primary{background:#fc6719}
table{border-collapse:collapse;width:100%;margin:12px 0}td{border-bottom:1px solid #33465e;padding:6px 8px;vertical-align:top;word-break:break-all}
.ok{color:#5fd38d}.fail{color:#ff6b6b}code{color:#ffd28a}
</style></head><body><h1>${escape(title)}</h1>${body}</body></html>`;
}

function rows(checks: Check[]) {
  return `<table>${checks
    .map(
      ([label, ok, detail]) =>
        `<tr><td class="${ok === null ? '' : ok ? 'ok' : 'fail'}">${ok === null ? '·' : ok ? '✓' : '✗'} ${escape(label)}</td><td>${escape(detail)}</td></tr>`,
    )
    .join('')}</table>`;
}

function claimsOf(idToken: string) {
  const payload = idToken.split('.', 2)[1] ?? '';

  return claimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
}

export function oidcSpikeRoutes(app: Hono<RuntimeEnv>, runtime: Runtime) {
  if (!oidcSpikeEnabled()) return;
  const crypto = new CryptoRepository();
  const pending = new Map<string, Pending>();
  const log = runtime.world.lifecycle.log;
  let discovery: z.infer<typeof discoverySchema> | null = null;

  async function discover() {
    if (discovery) return discovery;
    const response = await fetch(`${provider.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`);
    discovery = discoverySchema.parse(await response.json());

    return discovery;
  }

  function landing(c: Context<RuntimeEnv>) {
    return c.html(
      page(
        'Launcher SSO spike',
        `<p>Provider: <code>${escape(provider.issuer)}</code>${provider.clientId === 'interactive.public' ? ' — sign in as <code>bob</code> / <code>bob</code>' : ''}</p>
<p>Launcher session: ${c.get('browserId') ? `<span class="ok">present</span>` : `<span class="fail">missing</span>`} · page origin <code>${escape(new URL(c.req.url).origin)}</code></p>
<h2>1. Sign-in round trips</h2>
<p><a class="button primary" href="/auth/oidc-spike/start?mode=same-window">Sign in (same window)</a>
<a class="button" href="/auth/oidc-spike/start?mode=target-blank" target="_blank">Sign in (target=_blank)</a>
<button type="button" onclick="report('window.open', !!window.open('/auth/oidc-spike/start?mode=window-open'))">Sign in (window.open)</button></p>
<h2>2. Browser capabilities</h2>
<table id="env"></table>
<p><a class="button" href="https://webauthn.io/">Open webauthn.io (passkeys)</a>
<a class="button" href="https://accounts.google.com/">Open accounts.google.com</a></p>
<p><a class="button" href="/login/">Back to login</a></p>
<script>
function report(label, value) {
  const row = document.getElementById('env').insertRow();
  row.insertCell().textContent = label;
  row.insertCell().textContent = String(value);
  fetch('/auth/oidc-spike/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label, value: String(value) }) }).catch(() => {});
}
report('userAgent', navigator.userAgent);
report('cookieEnabled', navigator.cookieEnabled);
report('PublicKeyCredential', typeof window.PublicKeyCredential);
if (window.PublicKeyCredential?.isUserVerifyingPlatformAuthenticatorAvailable)
  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable().then((v) => report('platform authenticator', v), (e) => report('platform authenticator', e));
report('crypto.subtle', typeof crypto?.subtle);
report('opener', !!window.opener);
</script>`,
      ),
    );
  }

  app.get('/auth/oidc-spike', landing);
  app.post('/auth/oidc-spike', landing);

  app.post('/auth/oidc-spike/report', async (c) => {
    const input = z.object({ label: z.string().max(100), value: z.string().max(500) }).parse(await c.req.json());
    log.info('auth.oidc_spike', `Launcher capability ${input.label}: ${input.value}`);

    return c.body(null, 204);
  });

  app.get('/auth/oidc-spike/start', async (c) => {
    if (!c.get('browserId')) throw new HTTPException(401, { message: 'No launcher session cookie.' });
    const { authorization_endpoint } = await discover();
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(32).toString('base64url');
    const redirectUri = `${new URL(c.req.url).origin}/auth/oidc-spike/callback`;
    const mode = z.string().max(40).catch('unknown').parse(c.req.query('mode'));

    for (const [key, value] of pending) if (Date.now() - value.created > 600_000) pending.delete(key);
    pending.set(state, {
      browserId: c.get('browserId'),
      nonce: crypto.randomBytes(24).toString('base64url'),
      verifier,
      redirectUri,
      mode,
      created: Date.now(),
    });

    const url = new URL(authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: provider.scope,
      state,
      nonce: pending.get(state)!.nonce,
      code_challenge: crypto.pkceChallenge(verifier),
      code_challenge_method: 'S256',
    }).toString();
    log.info('auth.oidc_spike', `Starting ${mode} sign-in, redirect URI ${redirectUri}`);

    return c.redirect(url.href);
  });

  app.get('/auth/oidc-spike/callback', async (c) => {
    const query = c.req.query();
    const flow = pending.get(query.state ?? '');
    pending.delete(query.state ?? '');

    const checks: Check[] = [
      ['Returned to', null, new URL(c.req.url).origin],
      ['Flow', null, flow?.mode ?? 'unknown'],
      ['Provider error', !query.error, query.error ? `${query.error}: ${query.error_description ?? ''}` : 'none'],
      ['State known and unused', !!flow, flow ? `${Math.round((Date.now() - flow.created) / 1000)} s since start` : ''],
      [
        'Launcher session cookie survived the round trip',
        !!flow && flow.browserId === c.get('browserId'),
        c.get('browserId') ? 'cookie present' : 'no cookie',
      ],
    ];

    if (flow && query.code) {
      try {
        const metadata = await discover();

        const body = new URLSearchParams({
          grant_type: 'authorization_code',
          code: query.code,
          redirect_uri: flow.redirectUri,
          code_verifier: flow.verifier,
          client_id: provider.clientId,
        });

        const basic =
          !!provider.clientSecret &&
          (metadata.token_endpoint_auth_methods_supported?.includes('client_secret_basic') ?? true);

        if (provider.clientSecret && !basic) body.set('client_secret', provider.clientSecret);

        const response = await fetch(metadata.token_endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...(basic && {
              Authorization: `Basic ${Buffer.from(`${encodeURIComponent(provider.clientId)}:${encodeURIComponent(provider.clientSecret ?? '')}`).toString('base64')}`,
            }),
          },
          body,
        });

        const tokens = tokenSchema.parse(await response.json());
        checks.push([
          'Code exchanged server to server',
          response.ok,
          response.ok ? `HTTP ${response.status}` : JSON.stringify(tokens),
        ]);

        if (tokens.id_token) {
          // Received directly from the token endpoint over TLS, so the signature check is skipped (OIDC Core 3.1.3.7).
          const claims = claimsOf(tokens.id_token);
          const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
          checks.push(
            ['ID token issuer', claims.iss === metadata.issuer, claims.iss],
            ['ID token audience', audience.includes(provider.clientId), audience.join(', ')],
            ['ID token nonce', claims.nonce === flow.nonce, ''],
            ['ID token not expired', claims.exp * 1000 > Date.now(), new Date(claims.exp * 1000).toISOString()],
            ['sub', null, claims.sub],
            [
              'name / email / preferred_username',
              null,
              `${claims.name ?? '—'} / ${claims.email ?? '—'} / ${claims.preferred_username ?? '—'}`,
            ],
            ['auth_time', null, claims.auth_time ? new Date(claims.auth_time * 1000).toISOString() : 'absent'],
          );
        }
      } catch (error) {
        checks.push(['Code exchanged server to server', false, error instanceof Error ? error.message : String(error)]);
      }
    }

    const passed = checks.every(([, ok]) => ok !== false);
    log.info(
      'auth.oidc_spike',
      `Callback ${passed ? 'passed' : 'failed'}: ${checks
        .values()
        .filter(([, ok]) => ok !== null)
        .map(([label, ok]) => `${ok ? 'ok' : 'FAIL'} ${label}`)
        .toArray()
        .join('; ')}`,
    );

    return c.html(
      page(
        passed ? 'SSO round trip worked' : 'SSO round trip failed',
        `${rows(checks)}<p><a class="button primary" href="/auth/oidc-spike">Try again</a><a class="button" href="/login/">Back to login</a></p>`,
      ),
    );
  });
}
