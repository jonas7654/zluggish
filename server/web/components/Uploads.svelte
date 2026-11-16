<script lang="ts">
  import type { UploadJob } from '../../src/dtos/launcher.dto.js';

  let {
    initial,
    csrf,
    locked,
    onexpire,
  }: { initial: UploadJob[]; csrf: string; locked: boolean; onexpire: () => void } = $props();

  let jobs = $derived(initial);
  let message = $state('');

  $effect(() => {
    if (locked || !jobs.some((job) => ['pending', 'sending'].includes(job.state))) return;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    let stopped = false;
    let delay = 5000;

    function schedule() {
      clearTimeout(timer);

      if (!stopped && !document.hidden)
        timer = setTimeout(() => {
          void poll();
        }, delay);
    }

    async function poll() {
      if (stopped || document.hidden) return;
      controller = new AbortController();

      try {
        const response = await fetch('/ui/status/uploads', {
          credentials: 'same-origin',
          headers: { Accept: 'application/json', 'X-Launcher-Context': csrf },
          signal: controller.signal,
        });

        if (stopped) return;

        if ([401, 409].includes(response.status)) {
          stopped = true;
          onexpire();

          return;
        }

        if (!response.ok) throw new Error('Status unavailable');
        // SAFETY: the session-scoped endpoint returns only bounded upload summaries.
        const result = (await response.json()) as { jobs: UploadJob[] };

        if (stopped || document.hidden) return;
        jobs = result.jobs;
        message = '';
        delay = 5000;
      } catch {
        if (!stopped) {
          message = 'Upload status unavailable. Retrying later.';
          delay = Math.min(delay * 2, 60000);
        }
      }

      schedule();
    }

    function visibility() {
      clearTimeout(timer);
      controller?.abort();

      if (!document.hidden) schedule();
    }

    const leave = () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
    };

    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', leave);
    schedule();

    return () => {
      leave();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', leave);
    };
  });
</script>

<h2>Activity uploads</h2>
<ul>
  {#each jobs as job (`${job.activity_id}-${job.provider}`)}<li>
      Activity {job.activity_id}: {job.provider} — {job.state}
    </li>{/each}
</ul>
<p aria-live="polite">{message}</p>
