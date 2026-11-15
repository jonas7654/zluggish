<script lang="ts">
  import { untrack } from 'svelte';
  import type { PrototypePage } from '../../src/dtos/launcher.dto.js';
  let { csrf, riderName, settingsPath, ghosts, bridgeFolder, stravaMethod }: PrototypePage = $props();
  let draftGhosts = $state(untrack(() => ghosts));
  let draftFolder = $state(untrack(() => bridgeFolder));
  let draftMethod = $state(untrack(() => stravaMethod));
  let pending = $state(false);
  let message = $state('');
  let expired = $state(false);
  let dirty = $derived(draftGhosts !== ghosts || draftFolder !== bridgeFolder || draftMethod !== stravaMethod);
  let invalid = $derived(draftFolder.length > 500);
  let touched = $state(false);
  let controller: AbortController | undefined;
  $effect(() => () => controller?.abort());

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (pending || expired) return;
    touched = true;
    if (invalid) {
      document.querySelector<HTMLInputElement>('#bridge-folder')?.focus();
      return;
    }
    pending = true;
    message = 'Checking form…';
    controller = new AbortController();
    try {
      const response = await fetch('/ui/prototype/settings', {
        method: 'POST',
        body: new FormData(event.currentTarget as HTMLFormElement),
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (response.status === 401 || response.status === 400) expired = true;
      message = response.ok
        ? 'Form received. This prototype does not save preferences.'
        : 'Form failed. Reload or sign in and try again.';
    } catch {
      if (!controller.signal.aborted) message = 'Network error. Your draft is kept. Try again.';
    } finally {
      pending = false;
    }
  }
</script>

<svelte:head><title>Svelte launcher prototype</title></svelte:head>
<main>
  <h1>Svelte launcher prototype</h1>
  <p>{riderName}: compatibility test only. Preferences are not saved here.</p>
  <form method="post" action="/ui/prototype/settings" enctype="multipart/form-data" onsubmit={submit}>
    <input type="hidden" name="csrf_token" value={csrf} />
    <label><input type="checkbox" name="enableghosts" bind:checked={draftGhosts} />Enable ghosts</label>
    <label for="bridge-folder">TrainingPeaks export folder</label>
    <input
      id="bridge-folder"
      name="bridge_folder"
      bind:value={draftFolder}
      onblur={() => (touched = true)}
      aria-invalid={touched && invalid}
      aria-describedby={touched && invalid ? 'folder-error' : undefined}
    />
    {#if touched && invalid}<p id="folder-error" role="alert">Use at most 500 characters.</p>{/if}
    <label for="strava-method">Strava method</label>
    <select id="strava-method" name="strava_method" bind:value={draftMethod}>
      <option value="paid">API</option><option value="free">Session cookie</option>
    </select>
    <button disabled={pending || expired}>{pending ? 'Checking…' : 'Check form'}</button>
    <p aria-live="polite">{message || (dirty ? 'Draft changed' : 'Loaded preferences')}</p>
    {#if expired}<p><a href="/login/">Sign in</a> or reload this page.</p>{/if}
  </form>
  <p><a href={settingsPath}>Rider settings</a> · <a href="/">Launcher</a></p>
</main>

<style>
  :global(body) {
    font: 18px system-ui;
    margin: 2rem auto;
    padding: 1rem;
    max-width: 50rem;
  }
  label {
    display: block;
    margin-top: 1rem;
  }
  input,
  select,
  button {
    font: inherit;
    padding: 0.5rem;
    max-width: 100%;
    box-sizing: border-box;
  }
  button {
    display: block;
    margin-top: 1rem;
  }
  :global(:focus-visible) {
    outline: 3px solid #c75000;
    outline-offset: 3px;
  }
</style>
