<script lang="ts">
  import type { Snippet } from 'svelte';

  let {
    title,
    page,
    back,
    version,
    actions,
    onhome,
    children,
  }: {
    title: string;
    page: string;
    back?: { href: string; label: string } | undefined;
    version: string;
    /** Navigation at the end of the bar. The game app has none. */
    actions?: Snippet | undefined;
    onhome?: (() => void) | undefined;
    children: Snippet;
  } = $props();
</script>

<svelte:head><title>{title}</title></svelte:head>
<div class="bar">
  <a class="brand" href="/" aria-label="Zluggish home" onclick={(event) => {
    if (onhome && event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      onhome();
    }
  }}>
    <span class="logo" aria-hidden="true"></span>
    <span class="wordmark">zluggish</span>
  </a>
  {#if actions}{@render actions()}{/if}
  <span class="version">v{version}</span>
</div>
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
  /* Quiet, at the far end of the bar: there for support questions, not competing with the wordmark. */
  .version {
    margin-left: auto;
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
