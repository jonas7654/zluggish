<script lang="ts">
  import Avatar from './Avatar.svelte';

  let {
    initials,
    photo = null,
    name,
    detail = null,
  }: {
    initials: string;
    photo?: string | null | undefined;
    name: string;
    detail?: string | null | undefined;
  } = $props();
</script>

<Avatar {initials} {photo} /><span class="who"
  ><span>{name}</span>{#if detail}<small title={detail}>{detail}</small>{/if}</span
>
