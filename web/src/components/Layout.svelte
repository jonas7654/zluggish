<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    page,
    back,
    version,
    menu,
    onhome,
    children,
  }: {
    title: string;
    page: string;
    back?: { href: string; label: string } | undefined;
    version: string;
    /** Contents of the side menu behind the bar's menu button. The game app has none. */
    menu?: Snippet | undefined;
    onhome?: (() => void) | undefined;
    children: Snippet;
  } = $props();

  let drawer = $state<HTMLDialogElement>();
  let open = $state(false);

  function openMenu() {
    drawer?.showModal();
    open = true;
    drawer?.querySelector<HTMLElement>('[aria-current="page"]')?.focus();
  }
</script>

<svelte:head><title>{title}</title></svelte:head>
<div class="bar">
  {#if menu}<button
      class="round"
      aria-label="Menu"
      aria-haspopup="dialog"
      aria-controls="menu"
      aria-expanded={open}
      onclick={openMenu}
      ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" /></svg></button
    >{/if}
  <a class="brand" href="/" aria-label="Zluggish home" onclick={(event) => {
    if (onhome && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      onhome();
    }
  }}>
    <span class="logo" aria-hidden="true"></span>
    <span class="wordmark">zluggish</span>
  </a>
  {#if !menu && version}<span class="version">v{version}</span>{/if}
</div>
{#if menu}
  <!-- A click on the backdrop lands on the dialog itself; a click on any link or button inside navigates or acts. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
  <dialog
    id="menu"
    class="drawer"
    aria-label="Menu"
    bind:this={drawer}
    onclose={() => (open = false)}
    onclick={(event) => {
      if (event.target === drawer || (event.target as Element).closest('a, button')) drawer?.close();
    }}
  >
    <div class="sheet">
      <button class="round close" aria-label="Close menu"
        ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17" /></svg></button
      >
      {@render menu()}
      {#if version}<span class="version">v{version}</span>{/if}
    </div>
  </dialog>
{/if}
<main data-page={page}>
  <header>
    {#if back}<a class="back" href={back.href} aria-label={back.label} title={back.label}></a>{/if}
    <h1>{title}</h1>
  </header>
  {@render children()}
</main>

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.75rem max(1.5rem, calc((100% - 57rem) / 2));
    background: rgb(26 36 50 / 0.82);
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
  }
  /* Round outlined controls like Zwift's header buttons: the menu button, its close button and back. */
  .round {
    flex: none;
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    margin: 0 0.4rem 0 0;
    padding: 0;
    border: 2px solid rgb(255 255 255 / 0.7);
    border-radius: 50%;
  }
  .round:hover {
    border-color: var(--orange);
  }
  .round svg {
    width: 1.3rem;
    height: 1.3rem;
    fill: none;
    stroke: currentColor;
    stroke-width: 2.4;
    stroke-linecap: round;
  }

  /* The menu slides in from the left over the dimmed page. */
  .drawer {
    position: fixed;
    inset: 0 auto 0 0;
    width: min(19rem, 86vw);
    max-width: none;
    height: 100dvh;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    background: rgb(26 36 50 / 0.97);
    color: var(--text);
    box-shadow: 16px 0 48px rgb(0 0 0 / 0.45);
    transform: translateX(-100%);
    transition:
      transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
      overlay 220ms allow-discrete,
      display 220ms allow-discrete;
  }
  .drawer[open] {
    transform: none;
  }
  @starting-style {
    .drawer[open] {
      transform: translateX(-100%);
    }
  }
  .drawer::backdrop {
    background: rgb(8 12 18 / 0.6);
  }
  :global(html:has(dialog.drawer[open])) {
    overflow: hidden;
  }
  @media (prefers-reduced-motion: reduce) {
    .drawer {
      transition: none;
    }
  }
  .sheet {
    position: relative;
    display: flex;
    flex-direction: column;
    min-height: 100%;
    box-sizing: border-box;
    padding: 1.1rem 0 1rem;
  }
  .close {
    position: absolute;
    top: 0.85rem;
    right: 0.85rem;
    margin: 0;
  }
  .sheet .version {
    margin: 0.75rem 0 0 1.75rem;
  }

  .brand {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    text-decoration: none;
  }
  .logo {
    width: 3rem;
    height: 1.9rem;
    background: var(--orange);
    -webkit-mask: url('../../../media/zluggish.svg') center / contain no-repeat;
    mask: url('../../../media/zluggish.svg') center / contain no-repeat;
  }
  .wordmark {
    font-size: 1.125rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  /* Quiet, there for support questions, not competing with the wordmark. */
  .version {
    color: var(--muted);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }
  main {
    max-width: 57rem;
    margin: 0 auto;
    padding: 1.25rem 1.5rem 2rem;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 1rem;
  }
  header h1 {
    margin: 0;
  }
  /* A round outlined button like Zwift's header controls, holding a left chevron. */
  .bar .version {
    margin-left: auto;
  }
  .back {
    flex: none;
    position: relative;
    width: 2.5rem;
    height: 2.5rem;
    box-sizing: border-box;
    border: 2px solid rgb(255 255 255 / 0.7);
    border-radius: 50%;
  }
  .back::before {
    content: '';
    position: absolute;
    inset: 0;
    background: currentColor;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M14.5 5.5 8 12l6.5 6.5' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
      center / 1.3rem no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath d='M14.5 5.5 8 12l6.5 6.5' fill='none' stroke='black' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E")
      center / 1.3rem no-repeat;
  }
  .back:hover {
    background: rgb(255 255 255 / 0.12);
    border-color: var(--orange);
  }
  @media (max-width: 500px) {
    .bar,
    main {
      padding-inline: 1rem;
    }
  }
</style>
