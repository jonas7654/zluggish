<script lang="ts">
  import ActivityChart, { type Chart } from './ActivityChart.svelte';

  type Summary = {
    id: string;
    name: string;
    world: number;
    sport: 'cycling' | 'running';
    startDate: string | null;
    endDate: string | null;
    distanceInMeters: number;
    totalElevation: number;
    movingTimeInMs: number;
    calories: number;
    avgWatts: number;
    maxWatts: number;
    normalizedPower: number;
    tss: number;
    avgHeartRate: number;
    maxHeartRate: number;
    avgCadence: number;
    maxCadence: number;
    avgSpeed: number;
    maxSpeed: number;
    fit: boolean;
    images: number;
  };

  type Detail = Summary & { imageIds: number[]; chart: Chart | null; chartPending: boolean };

  let { path, api, go }: { path: string; api: <Body>(url: string) => Promise<Body>; go: (next: string) => void } =
    $props();

  const worlds = new Map([
    [2, 'Richmond'],
    [6, 'Watopia'],
    [7, 'London'],
    [8, 'New York'],
    [9, 'Innsbruck'],
    [10, 'Bologna'],
    [11, 'Yorkshire'],
    [12, 'Crit City'],
    [13, 'Makuri Islands'],
    [14, 'France'],
    [15, 'Paris'],
    [16, 'Gravel Mountain'],
    [17, 'Scotland'],
  ]);

  let activities = $state<Summary[] | null>(null);
  let detail = $state<Detail | null>(null);
  let failure = $state('');

  const selectedId = $derived(/^\/activities\/(\d+)$/.exec(path)?.[1] ?? null);

  const started = (a: Summary) => {
    const time = Date.parse(a.startDate ?? '');

    return Number.isFinite(time) ? new Date(time) : null;
  };

  /** Newest first, grouped by the month the activity started, with that month's totals. */
  const months = $derived.by(() => {
    const groups: { key: string; label: string; activities: Summary[]; distance: number; time: number }[] = [];

    const ordered = [...(activities ?? [])].sort(
      (a, b) => (started(b)?.getTime() ?? -Infinity) - (started(a)?.getTime() ?? -Infinity),
    );

    for (const activity of ordered) {
      const date = started(activity);
      const key = date ? `${date.getFullYear()}-${date.getMonth()}` : 'undated';
      let group = groups.at(-1);

      if (group?.key !== key) {
        group = {
          key,
          label: date ? date.toLocaleDateString([], { month: 'long', year: 'numeric' }) : 'Without a start date',
          activities: [],
          distance: 0,
          time: 0,
        };
        groups.push(group);
      }

      group.activities.push(activity);
      group.distance += activity.distanceInMeters;
      group.time += activity.movingTimeInMs;
    }

    return groups;
  });

  const km = (m: number) =>
    `${(m / 1000).toLocaleString([], { minimumFractionDigits: 1, maximumFractionDigits: 1 })} km`;

  const clock = (ms: number) => {
    const s = Math.round(ms / 1000);

    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  const hours = (ms: number) => {
    const minutes = Math.round(ms / 60_000);

    return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
  };

  /** Average speed as reported, else from distance over moving time. */
  const speed = (a: Summary) =>
    a.avgSpeed > 0 ? a.avgSpeed : a.movingTimeInMs > 0 ? a.distanceInMeters / (a.movingTimeInMs / 1000) : 0;

  const pace = (mps: number) => {
    const s = Math.round(1000 / mps);

    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')} /km`;
  };

  const pacing = (a: Summary, mps: number) =>
    mps <= 0 ? '' : a.sport === 'running' ? pace(mps) : `${(mps * 3.6).toFixed(1)} km/h`;

  const world = (a: Summary) => worlds.get(a.world) ?? (a.world ? `World ${a.world}` : '');
  const title = (a: Summary) => a.name.trim() || 'Untitled activity';

  /** Average and maximum side by side. A measure the activity did not record is left out. */
  const measures = (a: Detail) =>
    (
      [
        [
          'Power',
          a.sport === 'running' ? 0 : a.avgWatts,
          a.sport === 'running' ? 0 : a.maxWatts,
          (v: number) => `${Math.round(v)} W`,
        ],
        ['Heart rate', a.avgHeartRate, a.maxHeartRate, (v: number) => `${Math.round(v)} bpm`],
        [
          a.sport === 'running' ? 'Cadence' : 'Cadence',
          a.avgCadence,
          a.maxCadence,
          (v: number) => `${Math.round(v)} ${a.sport === 'running' ? 'spm' : 'rpm'}`,
        ],
        [a.sport === 'running' ? 'Pace' : 'Speed', speed(a), a.maxSpeed, (v: number) => pacing(a, v)],
      ] as const
    ).filter(([, avg, max]) => avg > 0 || max > 0);

  const extras = (a: Detail) =>
    (
      [
        ['Normalized power', a.normalizedPower, `${Math.round(a.normalizedPower)} W`],
        ['Training stress score', a.tss, `${Math.round(a.tss)}`],
        ['Calories', a.calories, `${Math.round(a.calories)} kcal`],
      ] as const
    ).filter(([, value]) => value > 0);

  async function loadList() {
    try {
      const body = await api<{ activities: Summary[] }>('/api/me/activities');
      activities = body.activities;
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Activities could not be loaded.';
    }
  }

  /** The chart is made by a job after the activity is saved; ask again a few times while it runs. */
  async function loadDetail(id: string, attempt = 0) {
    try {
      const body = await api<Detail>(`/api/me/activities/${id}`);

      if (selectedId !== id) return;
      detail = body;

      if (body.chartPending && attempt < 8) setTimeout(() => void loadDetail(id, attempt + 1), 1500 * (attempt + 1));
    } catch (error) {
      if (selectedId === id) failure = error instanceof Error ? error.message : 'The activity could not be loaded.';
    }
  }

  $effect(() => {
    void loadList();
  });

  $effect(() => {
    const id = selectedId;
    detail = null;
    failure = '';

    if (id) void loadDetail(id);
  });

  function open(event: MouseEvent, href: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    go(href);
    document.getElementById('activity-detail')?.focus();
  }
</script>

{#if failure}<p class="notice failed" role="alert">{failure}</p>{/if}

{#if activities === null}
  {#if !failure}<p role="status">Loading activities…</p>{/if}
{:else if activities.length === 0}
  <section class="panel narrow">
    <p>No activities yet. Activities you finish in the game appear here, with their FIT files and images.</p>
  </section>
{:else}
  <div class="activities" class:open={selectedId !== null}>
    <div class="log">
      {#each months as month (month.key)}
        <section class="month" aria-labelledby="month-{month.key}">
          <div class="month-head">
            <h2 id="month-{month.key}">{month.label}</h2>
            <p class="totals">
              {month.activities.length}
              {month.activities.length === 1 ? 'activity' : 'activities'}, {km(month.distance)}, {hours(month.time)}
            </p>
          </div>
          <ul class="plain">
            {#each month.activities as a (a.id)}
              {@const date = started(a)}
              <li>
                <a
                  class="activity"
                  href="/activities/{a.id}"
                  aria-current={selectedId === a.id ? 'page' : undefined}
                  onclick={(e) => open(e, `/activities/${a.id}`)}
                >
                  <span class="day" aria-hidden={date ? 'true' : undefined}
                    >{#if date}<small>{date.toLocaleDateString([], { weekday: 'short' })}</small
                      >{date.getDate()}{:else}<small>No date</small>{/if}</span
                  >
                  <span class="what">
                    <strong>{title(a)}</strong>
                    <small
                      >{#if date}<span class="visually-hidden"
                          >{date.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })},
                        </span>{/if}{world(a)}{#if a.sport === 'running'}{world(a)
                          ? ', run'
                          : 'Run'}{/if}{#if !a.endDate}<span class="unfinished"
                          >{world(a) || a.sport === 'running' ? ', ' : ''}not finished</span
                        >{/if}{#if a.images}<span class="camera"
                          ><span class="visually-hidden">, </span>{a.images}
                          {a.images === 1 ? 'image' : 'images'}</span
                        >{/if}</small
                    >
                  </span>
                  <span class="how">
                    <strong>{km(a.distanceInMeters)}</strong>
                    <small>{clock(a.movingTimeInMs)}</small>
                  </span>
                </a>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>

    <div class="detail">
      <section class="panel" id="activity-detail" tabindex="-1" aria-labelledby="activity-name">
        {#if !selectedId}
          <p class="muted">Choose an activity to see its route, stats, FIT file and images.</p>
        {:else if !detail}
          {#if !failure}<p role="status">Loading activity…</p>{/if}
          <a class="back" href="/activities" onclick={(e) => open(e, '/activities')}>All activities</a>
        {:else}
          {@const date = started(detail)}
          <a class="back" href="/activities" onclick={(e) => open(e, '/activities')}>All activities</a>
          <h2 id="activity-name">{title(detail)}</h2>
          <p class="when">
            {#if date}{date.toLocaleDateString([], {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}, {date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{/if}{#if world(detail)}{date
                ? ' in '
                : ''}{world(detail)}{/if}
          </p>

          {#if detail.chart && detail.chart.timeInSec.length > 1}
            {#key detail.id}<ActivityChart chart={detail.chart} running={detail.sport === 'running'} />{/key}
          {:else if detail.chartPending}
            <p class="pending" role="status">Preparing the route and elevation profile from the FIT file…</p>
          {/if}

          <dl class="headline">
            <div>
              <dt>Distance</dt>
              <dd>{km(detail.distanceInMeters)}</dd>
            </div>
            <div>
              <dt>Moving time</dt>
              <dd>{clock(detail.movingTimeInMs)}</dd>
            </div>
            <div>
              <dt>Elevation gain</dt>
              <dd>{Math.round(detail.totalElevation)} m</dd>
            </div>
          </dl>

          {#if measures(detail).length}
            <table class="measures">
              <caption class="visually-hidden">Averages and maximums</caption>
              <thead>
                <tr><td></td><th scope="col">Average</th><th scope="col">Max</th></tr>
              </thead>
              <tbody>
                {#each measures(detail) as [label, avg, max, format] (label)}
                  <tr>
                    <th scope="row">{label}</th>
                    <td>{avg > 0 ? format(avg) : '–'}</td>
                    <td>{max > 0 ? format(max) : '–'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}

          {#if extras(detail).length}
            <dl class="config">
              {#each extras(detail) as [label, , text] (label)}<div>
                  <dt>{label}</dt>
                  <dd class="num">{text}</dd>
                </div>{/each}
            </dl>
          {/if}

          <div class="inset">
            <h3>FIT file</h3>
            {#if detail.fit}
              <p class="muted">The recording from the game, for Strava, Garmin Connect or any training app.</p>
              <a class="button primary" href="/api/me/activities/{detail.id}/fit" download>Download FIT file</a>
            {:else}
              <p class="muted">The game saved no FIT file for this activity.</p>
            {/if}
          </div>

          {#if detail.imageIds.length}
            <div class="inset">
              <h3>Images</h3>
              <ul class="plain images">
                {#each detail.imageIds as image, index (image)}
                  <li>
                    <a href="/api/me/activities/{detail.id}/images/{image}" target="_blank" rel="noopener">
                      <img
                        src="/api/me/activities/{detail.id}/images/{image}"
                        alt="Image {index + 1} of {detail.imageIds.length} from {title(detail)}"
                        loading="lazy"
                      />
                    </a>
                    <a class="download" href="/api/me/activities/{detail.id}/images/{image}?download" download
                      >Download<span class="visually-hidden"> image {index + 1}</span></a
                    >
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        {/if}
      </section>
    </div>
  </div>
{/if}

<style>
  .activities {
    display: grid;
    gap: 1rem;
    align-items: start;
  }
  @media (min-width: 62rem) {
    .activities {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1.15fr);
    }
    .detail {
      position: sticky;
      top: 1rem;
    }
    .detail .back {
      display: none;
    }
  }
  /* On a phone, an open activity takes the screen; the list is one link away. */
  @media (max-width: 61.99rem) {
    .open .log,
    .activities:not(.open) .detail {
      display: none;
    }
  }

  .panel {
    background: var(--glass);
    border-radius: 12px;
    padding: 1.25rem;
    margin: 0 0 1rem;
    -webkit-backdrop-filter: blur(8px);
    backdrop-filter: blur(8px);
  }
  .panel:focus {
    outline: none;
  }
  .narrow {
    max-width: 34rem;
  }
  .plain {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .muted {
    color: var(--muted);
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .notice.failed {
    color: var(--alarm);
    border-left: 3px solid #ff6b57;
  }

  .month + .month {
    margin-top: 1.5rem;
  }
  .month-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.25rem 1rem;
    margin: 0 0 0.5rem;
    padding: 0 0.25rem;
  }
  .month-head h2 {
    margin: 0;
    font-size: 1.125rem;
    text-transform: none;
    letter-spacing: 0;
  }
  .totals {
    margin: 0;
    color: var(--muted);
    font-size: 0.8125rem;
    font-variant-numeric: tabular-nums;
  }

  li + li {
    margin-top: 0.4rem;
  }
  .activity {
    display: grid;
    grid-template-columns: 2.75rem minmax(0, 1fr) auto;
    align-items: center;
    gap: 0.85rem;
    padding: 0.55rem 0.85rem 0.55rem 0.6rem;
    border: 2px solid transparent;
    border-radius: 12px;
    background: var(--glass);
    text-decoration: none;
  }
  .activity:hover {
    background: var(--glass-raised);
    border-color: var(--orange);
  }
  .activity[aria-current] {
    background: var(--glass-raised);
    border-color: var(--text);
  }
  .activity small {
    display: block;
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .day {
    display: grid;
    justify-items: center;
    font-size: 1.375rem;
    font-weight: 800;
    line-height: 1.05;
    font-variant-numeric: tabular-nums;
  }
  .day small {
    font-size: 0.6875rem;
  }
  .what {
    min-width: 0;
  }
  .what strong {
    display: block;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .what small {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .camera {
    margin-left: 0.6rem;
  }
  .camera::before {
    content: '';
    display: inline-block;
    width: 0.85rem;
    height: 0.7rem;
    margin-right: 0.3rem;
    background: currentColor;
    vertical-align: -0.05rem;
    -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 20'%3E%3Cpath d='M8 0 6 3H2a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4l-2-3zm4 6a5 5 0 1 1 0 10 5 5 0 0 1 0-10z'/%3E%3C/svg%3E")
      center / contain no-repeat;
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 20'%3E%3Cpath d='M8 0 6 3H2a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h20a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-4l-2-3zm4 6a5 5 0 1 1 0 10 5 5 0 0 1 0-10z'/%3E%3C/svg%3E")
      center / contain no-repeat;
  }
  .how {
    text-align: right;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .back {
    display: inline-block;
    margin-bottom: 0.75rem;
    font-size: 0.8125rem;
    font-weight: 800;
  }
  .back::before {
    content: '‹ ';
  }
  .detail h2 {
    margin: 0 0 0.25rem;
    font-size: 1.375rem;
    text-transform: none;
    letter-spacing: 0;
    overflow-wrap: anywhere;
  }
  .when {
    margin: 0 0 1rem;
    color: var(--muted);
  }
  .pending {
    padding: 0.75rem 0.9rem;
    border-radius: 10px;
    background: var(--well);
    color: var(--muted);
  }

  .headline {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 0 0 1rem;
  }
  .headline dt {
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .headline dd {
    margin: 0.1rem 0 0;
    font-size: 1.375rem;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .measures {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }
  .measures th,
  .measures td {
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--line);
    text-align: right;
    font-weight: 600;
  }
  .measures thead th {
    color: var(--muted);
    font-size: 0.8125rem;
  }
  .measures tbody th {
    text-align: left;
    color: var(--muted);
  }
  .measures tbody td {
    font-weight: 800;
  }

  .config {
    display: grid;
    gap: 0;
    margin: 0;
  }
  .config div {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.75rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--line);
  }
  .config dt {
    color: var(--muted);
  }
  .config dd {
    margin: 0;
    font-weight: 800;
  }

  .inset {
    padding: 1rem 0 0;
    margin: 1rem 0 0;
    border-top: 1px solid var(--line);
  }
  .config + .inset,
  .measures + .inset {
    border-top: 0;
  }
  h3 {
    margin: 0 0 0.25rem;
    font-size: 0.9375rem;
    font-weight: 800;
  }
  .inset p {
    margin: 0 0 0.75rem;
  }
  /* The download is a link, dressed as the page's one orange action. */
  a.button {
    display: inline-block;
    padding: 0.65rem 1.4rem;
    border-radius: 10px;
    background: var(--orange);
    box-shadow: 0 3px 0 var(--orange-deep);
    font-size: 0.875rem;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.02em;
    text-decoration: none;
  }
  a.button:hover {
    background: #f06a1e;
  }
  a.button:active {
    transform: translateY(2px);
    box-shadow: 0 1px 0 var(--orange-deep);
  }

  .images {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    gap: 0.75rem;
    margin-top: 0.5rem;
  }
  .images li + li {
    margin: 0;
  }
  .images img {
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    object-fit: cover;
    border-radius: 8px;
    background: var(--well);
  }
  .images a:first-child:hover img {
    outline: 2px solid var(--orange);
    outline-offset: 2px;
  }
  .download {
    display: inline-block;
    margin-top: 0.3rem;
    font-size: 0.8125rem;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  @media (max-width: 500px) {
    .panel {
      padding: 0.9rem;
    }
    .headline dd {
      font-size: 1.125rem;
    }
  }
</style>
