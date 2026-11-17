<script lang="ts">
  import { untrack } from 'svelte';
  import Layout from '../../components/Layout.svelte';
  import Form from '../../components/Form.svelte';
  import Uploads from '../../components/Uploads.svelte';
  import type { GamePageModel } from '../../lib/game-app.dto';

  let { page }: { page: GamePageModel } = $props();
  let current = $state(untrack(() => page));
  let locked = $state(false);
  let selectedMethod = $state(untrack(() => page.stravaMethod ?? 'paid'));

  // Counts failures handed up from the user list, so the same message twice is shown and announced again.
  let failures = $state(0);

  function expire() {
    locked = true;
  }

  $effect(() => {
    // The launcher's public loading screen has no rider session to monitor.
    if (!current.csrf) return;

    const channel = 'BroadcastChannel' in window ? new BroadcastChannel('zluggish-session-change') : undefined;
    let controller: AbortController | undefined;
    let alive = true;
    channel?.addEventListener('message', expire);

    async function check() {
      if (document.hidden || locked) return;
      controller?.abort();
      controller = new AbortController();

      try {
        const response = await fetch('/ui/status/session', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'X-Game-Context': current.csrf },
          signal: controller.signal,
        });

        if (alive && [401, 409].includes(response.status)) expire();
      } catch {
        /* A network error is not proof that the session expired. */
      }
    }

    const focus = () => {
      void check();
    };

    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', focus);

    return () => {
      alive = false;
      controller?.abort();
      channel?.close();
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  });
</script>

<Layout
  title={current.title}
  page={current.kind}
  back={current.back}
  version={current.version}
  zwiftVersion={current.zwiftVersion}
>
  {#if current.links?.length}<nav aria-label="User pages">
      {#each current.links as link (link.href)}<a href={link.href}>{link.label}</a>{/each}
    </nav>{/if}
  {#each current.paragraphs ?? [] as text, index (index)}<p>{text}</p>{/each}
  {#key failures}{#if current.message}<p class="notice" role={current.failed ? 'alert' : 'status'}>
        {current.message}
      </p>{/if}{/key}
  {#if locked}<p class="error" role="alert">
      Your session or user changed. <a href="/login/">Sign in</a> or
      <button type="button" onclick={() => location.reload()}>Reload this page</button>.
    </p>{/if}
  {#if current.uploads}<Uploads initial={current.uploads} csrf={current.csrf} {locked} onexpire={expire} />{/if}
  {#each current.forms as model (model.id)}
    <div
      hidden={(current.kind === 'dashboard' && model.id === 'switch') ||
        (model.method !== undefined && model.method !== selectedMethod)}
    >
      <Form
        {model}
        csrf={current.csrf}
        {locked}
        onpage={(value) => {
          if (value.kind !== 'message') current = value;
          else if (value.uploads) current = { ...current, uploads: value.uploads };
        }}
        onexpire={expire}
        onfail={model.user
          ? (message) => {
              current = { ...current, message, failed: true };
              failures++;
            }
          : undefined}
        onchange={(name, value) => {
          if (name === 'method') selectedMethod = value === 'free' ? 'free' : 'paid';
        }}
      >
        {#snippet actions()}
          {#if current.kind === 'dashboard' && model.id === 'launch'}
            <button type="submit" form="game-form-switch" disabled={locked}>Switch rider</button>
          {/if}
        {/snippet}
      </Form>
    </div>
  {/each}
  {#if current.kind === 'dashboard'}
    <p class="settings-note">Use the separate webapp to change settings.</p>
  {/if}
</Layout>

<style>
  .settings-note {
    color: var(--muted);
  }
</style>
