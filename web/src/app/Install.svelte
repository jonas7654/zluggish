<script lang="ts">
  import { onMount } from 'svelte';
  import Fingerprint from '../components/Fingerprint.svelte';
  import type { TlsStatus } from './tls';

  let { api }: { api: <Body>(url: string) => Promise<Body> } = $props();

  type Platform = 'windows' | 'linux';

  let status = $state<TlsStatus | null>(null);
  let failure = $state('');

  let platform = $state<Platform>(
    /Linux/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent) ? 'linux' : 'windows',
  );

  let redirect = $state(true);
  let address = $state('');

  const loopback = (value: string) => value === 'localhost' || value === '::1' || value.startsWith('127.');

  const looksLikeIp = (value: string) =>
    /^(\d{1,3}\.){3}\d{1,3}$/.test(value) || (value.includes(':') && /^[\da-f:.]+$/i.test(value));

  const addressError = $derived(
    !redirect
      ? ''
      : !address.trim()
        ? 'Enter the IP address of the server.'
        : looksLikeIp(address.trim())
          ? ''
          : 'Enter an IP address, such as 192.168.1.20.',
  );

  const script = $derived(
    `/api/tls/setup/${platform}?${new URLSearchParams({ address: redirect ? address.trim() : '' })}`,
  );

  const installable = $derived(status?.mode === 'managed' || status?.mode === 'custom');

  const day = (iso: string) => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });

  onMount(async () => {
    try {
      status = await api<TlsStatus>('/api/tls');
      // The address this browser reached the web app at is the best guess when the server only knows loopback.
      const host = location.hostname.replace(/^\[|\]$/g, '');
      address = loopback(status.serverAddress) && looksLikeIp(host) && !loopback(host) ? host : status.serverAddress;
    } catch (error) {
      failure = error instanceof Error ? error.message : 'The certificate could not be loaded.';
    }
  });
</script>

{#if failure}<p class="notice failed" role="alert">{failure}</p>{/if}
{#if status === null}
  {#if !failure}<p role="status">Loading…</p>{/if}
{:else if status.mode === 'legacy'}
  <section class="panel unsafe" aria-labelledby="install-legacy">
    <h2 id="install-legacy">This server is not ready for setup</h2>
    <p>
      It still uses the shared Zwift certificate. That certificate's private key is published on the internet, so others
      on your network could read your Zwift traffic, your password included.
    </p>
    <p>Ask the server administrator to generate a server certificate. Then come back here to set up your computer.</p>
  </section>
{:else if status.mode === 'disabled'}
  <section class="panel" aria-labelledby="install-plain">
    <h2 id="install-plain">Nothing to install</h2>
    <p>This server talks to Zwift without a certificate. Ask the server administrator how to connect.</p>
  </section>
{/if}

{#if status && installable && status.certificate}
  <section class="panel setup" aria-labelledby="install-title">
    <h2 id="install-title">Set up a computer</h2>
    <p class="lead">
      Zwift only talks to a server it trusts. The setup script makes this computer trust this server's certificate and
      sends Zwift here instead of to Zwift's own servers.
    </p>

    <div class="choice" role="radiogroup" aria-label="Operating system">
      <label class:checked={platform === 'windows'}
        ><input type="radio" bind:group={platform} value="windows" />
        <span><strong>Windows</strong><small>Zwift installed from zwift.com</small></span></label
      >
      <label class:checked={platform === 'linux'}
        ><input type="radio" bind:group={platform} value="linux" />
        <span><strong>Linux</strong><small>Zwift in Wine, Lutris, Bottles or Steam</small></span></label
      >
    </div>

    <label class="check"><input type="checkbox" bind:checked={redirect} /> Send Zwift to this server</label>
    {#if redirect}
      <label for="install-address">Server IP address</label>
      <input
        id="install-address"
        bind:value={address}
        inputmode="decimal"
        autocomplete="off"
        spellcheck="false"
        maxlength={45}
        aria-invalid={!!addressError}
        aria-describedby="install-address-hint"
      />
      <p id="install-address-hint" class="hint" class:failed={!!addressError}>
        {addressError || 'The script adds this address to the hosts file for the Zwift server names.'}
      </p>
    {:else}
      <p class="hint">The script leaves the hosts file alone. Point Zwift at the server some other way, such as DNS.</p>
    {/if}

    {#if addressError}
      <button class="primary" type="button" disabled>Download setup script</button>
    {:else}
      <a class="download" href={script} download>Download setup script</a>
    {/if}

    <ol class="steps">
      {#if platform === 'windows'}
        <li>Open the downloaded <strong>.bat</strong> file. Windows asks for administrator rights. Allow it.</li>
        <li>
          If Windows SmartScreen stops the file, select <strong>More info</strong>, then <strong>Run anyway</strong>.
        </li>
        <li>When the window says <strong>Done</strong>, start Zwift and sign in.</li>
      {:else}
        <li>
          In a terminal, run <code>sh</code> with the downloaded <strong>.sh</strong> file. It asks for your password through
          sudo.
        </li>
        <li>If it does not find Zwift, run it again with the Zwift folder as the last argument.</li>
        <li>When it says <strong>Done</strong>, close Zwift's Wine prefix, start Zwift and sign in.</li>
      {/if}
    </ol>
    <p class="hint">
      Run the script again after a Zwift update and after the administrator rotates the certificate. It also removes the
      old shared Zwift certificate from the computer.
    </p>
  </section>

  <section class="panel" aria-labelledby="install-certificate">
    <h2 id="install-certificate">Check the certificate</h2>
    <p>
      The script prints the thumbprint it installs. Windows shows it as <strong>Thumbprint</strong> in the certificate's
      details. It should match this one.
    </p>
    <div class="prints">
      <Fingerprint label="Thumbprint (SHA-1)" value={status.certificate.thumbprint} />
      <Fingerprint label="SHA-256 fingerprint" value={status.certificate.fingerprint256} />
    </div>
    <p class="muted">Valid until {day(status.certificate.notAfter)}.</p>
    <p class="manual">
      To install it by hand, download the certificate as
      <a href="/api/tls/certificate?format=der" download>.cer for Windows</a> or
      <a href="/api/tls/certificate" download>.crt (PEM) for Linux and macOS</a>.
    </p>
  </section>
{/if}

<style>
  .panel {
    background: var(--glass);
    border-radius: 12px;
    padding: 1.25rem;
    margin: 0 0 1rem;
    max-width: 44rem;
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
  /* The same warning edge as the other alerts, on a whole panel. */
  .unsafe {
    border-left: 4px solid #ff6b57;
  }
  .unsafe h2 {
    color: var(--alarm);
  }
  .lead {
    margin-top: 0;
  }
  .muted,
  .hint {
    color: var(--muted);
  }
  .hint {
    margin: 0.4rem 0 0;
    font-size: 0.875rem;
  }
  .hint.failed {
    color: var(--alarm);
  }
  .notice.failed {
    color: var(--alarm);
    border-left: 3px solid #ff6b57;
  }

  .choice {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.5rem;
    margin: 1rem 0 0.5rem;
  }
  .choice label {
    display: flex;
    align-items: flex-start;
    gap: 0.65rem;
    margin: 0;
    padding: 0.8rem 0.9rem;
    border: 2px solid var(--line);
    border-radius: 10px;
    color: var(--text);
    cursor: pointer;
  }
  .choice label.checked {
    border-color: var(--orange);
    background: var(--glass-raised);
  }
  .choice label:has(:focus-visible) {
    outline: 2px solid var(--text);
    outline-offset: 3px;
  }
  .choice input {
    flex: none;
    width: auto;
    margin: 0.2rem 0 0;
    accent-color: var(--orange);
  }
  .choice strong {
    display: block;
    font-weight: 800;
  }
  .choice small {
    color: var(--muted);
    font-size: 0.8125rem;
  }
  label.check {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    margin-top: 1rem;
    color: var(--text);
  }
  input[aria-invalid='true'] {
    border-color: #ff6b57;
  }

  /* The page's one main action: a download link dressed as the orange button. */
  a.download {
    display: inline-block;
    margin: 1.25rem 0 0;
    padding: 0.65rem 1.4rem;
    border-radius: 10px;
    background: var(--orange);
    box-shadow: 0 3px 0 var(--orange-deep);
    font-weight: 800;
    font-size: 0.875rem;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    text-decoration: none;
  }
  a.download:hover {
    background: #f06a1e;
  }
  a.download:active {
    transform: translateY(2px);
    box-shadow: 0 1px 0 var(--orange-deep);
  }
  .setup button {
    margin: 1.25rem 0 0;
  }

  .steps {
    margin: 1.25rem 0 0;
    padding-left: 1.4rem;
  }
  .steps li {
    margin-bottom: 0.35rem;
    padding-left: 0.25rem;
  }
  .steps li::marker {
    color: var(--orange);
    font-weight: 800;
  }
  code {
    padding: 0.05rem 0.35rem;
    border-radius: 4px;
    background: var(--well);
  }

  .prints {
    display: grid;
    gap: 1rem;
    margin: 1rem 0;
  }
  .manual {
    margin-bottom: 0;
  }
</style>
