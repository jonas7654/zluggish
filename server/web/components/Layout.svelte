<script lang="ts">
  import type { Snippet } from 'svelte';

  let { title, page, children }: { title: string; page: string; children: Snippet } = $props();
</script>

<svelte:head><title>{title}</title></svelte:head>
<header>
  <span class="logo" aria-hidden="true"></span>
  <span class="wordmark">zluggish</span>
</header>
<main data-page={page}>
  <h1>{title}</h1>
  {@render children()}
</main>

<style>
  header {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.75rem max(1.5rem, calc((100% - 57rem) / 2));
    background: rgb(26 36 50 / 0.82);
    -webkit-backdrop-filter: blur(10px);
    backdrop-filter: blur(10px);
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
  main {
    max-width: 57rem;
    margin: 0 auto;
    padding: 1.25rem 1.5rem 2rem;
  }
  @media (max-width: 500px) {
    header,
    main {
      padding-inline: 1rem;
    }
  }
</style>
