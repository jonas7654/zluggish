import { ManagementService } from '#src/services/management.service';
import { ActivitiesService } from '#src/services/activities.service';
import { JobsService } from '#src/services/jobs.service';
import { Effect } from 'effect';
import { WorkoutsService } from '#src/services/workout.service';
import { ConnectionsService } from '#src/services/connections.service';
import { DocumentsService } from '#src/services/documents.service';
/**
Captures the README screenshots from a throwaway server seeded with fictional riders.

  pnpm --dir server screenshots

Images are written to media/screenshots. Nothing is read from or written to real storage,
and every outgoing request is refused.
*/
import { createWebApp } from '#src/http/web-app';
import { ActivitySchema } from '#src/protocol/generated/activity_pb';
import { PlayerStateSchema } from '#src/protocol/generated/udp-node-msgs_pb';
import type { User } from '#src/repositories/accounts.repository';
import { worldTime } from '#src/world/state';
import { runtimeFixture } from '#tests/support/runtime';
import { create, toBinary } from '@bufbuild/protobuf';
import { Encoder, Profile } from '@garmin/fitsdk';
import type { ActivityMesg, FileIdMesg, RecordMesg, SessionMesg } from '@garmin/fitsdk';
import { serve } from '@hono/node-server';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { Schema } from 'effect';

const out = path.resolve(import.meta.dirname, '../../media/screenshots');
const password = 'screenshot-password';

// The same riders and rides on every run, so regenerated images only change when the UI does.
const random = (() => {
  let state = 20_261_117;

  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;

    return state / 2_147_483_648;
  };
})();

type Fixture = ReturnType<typeof runtimeFixture>;

type Rider = { name: string; username: string; ftp: number; avatar?: [string, string, string] };

const riders: Rider[] = [
  { name: 'Maja Lindqvist', username: 'maja@example.com', ftp: 248, avatar: ['#ffb38a', '#e2560c', '#3a1d5c'] },
  { name: 'Tomás Herrera', username: 'tomas@example.com', ftp: 290, avatar: ['#a8e6cf', '#2a9d8f', '#1d3557'] },
  { name: 'Aiko Tanaka', username: 'aiko@example.com', ftp: 205 },
  { name: 'Sam Okafor', username: 'sam@example.com', ftp: 270, avatar: ['#ffe29a', '#f4a261', '#264653'] },
  { name: 'Lena Fischer', username: 'lena@example.com', ftp: 220 },
];

// Each world's id and real-world coordinates near its map, as the game reports them.
const worlds = {
  richmond: { id: 2, at: [37.54, -77.44] },
  watopia: { id: 6, at: [-11.64, 166.95] },
  london: { id: 7, at: [51.5, -0.12] },
  newYork: { id: 8, at: [40.77, -73.97] },
  innsbruck: { id: 9, at: [47.27, 11.39] },
  yorkshire: { id: 11, at: [53.99, -1.54] },
  makuri: { id: 13, at: [-10.77, 165.84] },
  france: { id: 14, at: [-21.7, 166.18] },
  paris: { id: 15, at: [48.87, 2.31] },
  scotland: { id: 17, at: [55.86, -4.25] },
} as const;

type World = (typeof worlds)[keyof typeof worlds];

type Ride = { name: string; world: World; km: number; climb: number; daysAgo: number; hour: number; effort: number };

const ride = (name: string, world: World, km: number, climb: number, daysAgo: number, hour: number, effort: number) =>
  ({ name: `Zwift - ${name}`, world, km, climb, daysAgo, hour, effort }) satisfies Ride;

const rides: Ride[] = [
  ride('Mountain 8 in Watopia', worlds.watopia, 31.7, 644, 1, 6, 0.82),
  ride('Tempus Fugit in Watopia', worlds.watopia, 34.6, 41, 2, 18, 0.72),
  ride('Alpe du Zwift in Watopia', worlds.watopia, 24.8, 1123, 3, 18, 0.86),
  ride('Sweet Spot 3x15 on Volcano Flat', worlds.watopia, 41.2, 120, 5, 7, 0.88),
  ride('Greatest London Loop', worlds.london, 37.5, 498, 7, 17, 0.74),
  ride('Hilly Route in Makuri Islands', worlds.makuri, 18.2, 197, 9, 6, 0.7),
  ride('Park Perimeter Loop in New York', worlds.newYork, 28.4, 305, 12, 19, 0.78),
  ride('Innsbruckring', worlds.innsbruck, 26.1, 435, 14, 8, 0.8),
  ride('2019 UCI Worlds Harrogate Circuit', worlds.yorkshire, 22.9, 233, 17, 17, 0.83),
  ride('Richmond UCI Worlds', worlds.richmond, 32.8, 334, 20, 7, 0.76),
  ride('Ven-Top in France', worlds.france, 33.9, 1563, 23, 9, 0.84),
  ride('Glasgow Crit Circuit in Scotland', worlds.scotland, 21.6, 168, 27, 18, 0.9),
  ride('Champs-Élysées in Paris', worlds.paris, 25.8, 96, 31, 12, 0.79),
  ride('Watopia Flat Route Reverse', worlds.watopia, 43.4, 98, 36, 7, 0.68),
];

const messages = Schema.decodeUnknownSync(
  Schema.Struct({ FILE_ID: Schema.Finite, RECORD: Schema.Finite, SESSION: Schema.Finite, ACTIVITY: Schema.Finite }),
)(Profile.MesgNum);

// A wobbly closed loop with a few hills, so each ride reads as a real course on the map.
function course(km: number, climb: number, samples: number) {
  const harmonics = Array.from({ length: 4 }, (_, k) => ({
    amplitude: (random() * 0.35) / (k + 1),
    phase: random() * Math.PI * 2,
    frequency: k + 2,
  }));

  const hills = Array.from({ length: 5 }, (_, k) => ({
    at: (k + random()) / 5,
    width: 0.02 + random() * 0.08,
    height: 0.3 + random() * 0.7,
  }));

  const radius = (km * 1000) / (2 * Math.PI);

  const points = Array.from({ length: samples }, (_, index) => {
    const t = index / samples;
    const angle = t * Math.PI * 2;
    const wobble = harmonics.reduce((sum, h) => sum + h.amplitude * Math.sin(h.frequency * angle + h.phase), 0);
    const altitude = hills.reduce((sum, hill) => sum + hill.height * Math.exp(-(((t - hill.at) / hill.width) ** 2)), 0);

    return { x: radius * (1 + wobble) * Math.cos(angle), y: radius * (1 + wobble) * Math.sin(angle) * 0.7, altitude };
  });

  const peak = Math.max(...points.map((p) => p.altitude));

  return points.map((p) => ({ ...p, altitude: 20 + (p.altitude / peak) * Math.min(climb, 1500) * 0.7 }));
}

function fitFile(planned: Ride, rider: Rider, start: Date) {
  const speed = (8.2 + planned.effort * 3) * (planned.climb > 1000 ? 0.62 : 1);
  const seconds = Math.round((planned.km * 1000) / speed);
  const [lat, lng] = planned.world.at;
  const route = course(planned.km, planned.climb, seconds);
  const metresPerDegree = 111_320;
  const semicircles = (degrees: number) => Math.round(degrees * 11_930_465);
  const encoder = new Encoder();
  const file: FileIdMesg = { type: 'activity', manufacturer: 'zwift', product: 0, timeCreated: start, serialNumber: 1 };
  encoder.onMesg(messages.FILE_ID, file);

  let distance = 0;
  let power = rider.ftp * planned.effort;
  let heartRate = 110;
  const powers: number[] = [];

  for (const [index, point] of route.entries()) {
    const next = route[index + 1] ?? point;
    const grade = (next.altitude - point.altitude) / Math.max(1, speed);
    const surge = (Math.sin(index / 47) + Math.sin(index / 13)) * 12;
    const target = rider.ftp * planned.effort * (1 + grade * 6) + surge;
    power = Math.max(60, power + (target - power) * 0.08 + (random() - 0.5) * 30);
    heartRate += (95 + (power / rider.ftp) * 70 + index / 120 - heartRate) * 0.01;
    distance += speed * (0.85 + Math.min(0.3, power / rider.ftp / 4));
    powers.push(power);

    const record: RecordMesg = {
      timestamp: new Date(start.getTime() + index * 1000),
      positionLat: semicircles(lat + point.y / metresPerDegree),
      positionLong: semicircles(lng + point.x / (metresPerDegree * Math.cos((lat * Math.PI) / 180))),
      distance,
      altitude: point.altitude,
      speed: speed * (1 - grade * 2),
      power: Math.round(power),
      heartRate: Math.round(Math.min(188, heartRate)),
      cadence: Math.round(84 + (random() - 0.5) * 8 - grade * 40),
    };

    encoder.onMesg(messages.RECORD, record);
  }

  const end = new Date(start.getTime() + seconds * 1000);
  const avgWatts = powers.reduce((sum, p) => sum + p, 0) / powers.length;

  const session: SessionMesg = {
    timestamp: end,
    startTime: start,
    totalElapsedTime: seconds,
    totalTimerTime: seconds,
    totalDistance: distance,
    sport: 'cycling',
    avgPower: Math.round(avgWatts),
  };

  const activity: ActivityMesg = { timestamp: end, numSessions: 1, totalTimerTime: seconds };
  encoder.onMesg(messages.SESSION, session);
  encoder.onMesg(messages.ACTIVITY, activity);

  return { fit: encoder.close(), end, seconds, distance, avgWatts, maxWatts: Math.max(...powers) };
}

// Rides go through the game API, so charts and power curves come from the real jobs.
async function seedActivities(f: Fixture, user: User, rider: Rider) {
  const base = `/api/profiles/${user.player_id}/activities`;

  const headers = {
    Authorization: `Bearer ${f.sessions.tokens(user, f.tokens).access_token}`,
    'Content-Type': 'application/x-protobuf-lite',
  };

  for (const planned of rides) {
    const start = new Date();
    start.setDate(start.getDate() - planned.daysAgo);
    start.setHours(planned.hour, Math.floor(random() * 50), 0, 0);
    const { fit, end, seconds, distance, avgWatts, maxWatts } = fitFile(planned, rider, start);

    const activity = {
      playerId: BigInt(user.player_id),
      courseId: BigInt(planned.world.id),
      name: planned.name,
      sport: 0,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      distanceInMeters: distance,
      totalElevation: planned.climb,
      movingTimeInMs: BigInt(seconds * 1000),
      avgWatts,
      maxWatts,
      normalizedPower: avgWatts * 1.06,
      tss: (seconds / 3600) * planned.effort ** 2 * 100,
      avgHeartRate: 128 + planned.effort * 25,
      maxHeartRate: 168 + planned.effort * 12,
      avgCadence: 86,
      maxCadence: 112,
      avgSpeed: distance / seconds,
      maxSpeed: (distance / seconds) * 1.8,
      calories: avgWatts * seconds * 0.0011,
    };

    const draft = toBinary(ActivitySchema, create(ActivitySchema, activity));
    const created = await f.app.request(base, { method: 'POST', headers, body: draft });
    const { id } = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.Finite }))(await created.json());
    const complete = toBinary(ActivitySchema, create(ActivitySchema, { ...activity, id: BigInt(id), fit }));

    const finished = await f.app.request(`${base}/${id}?upload-to-strava=true`, {
      method: 'PUT',
      headers,
      body: complete,
    });

    if (finished.status !== 200) throw new Error(`Activity save failed: ${finished.status}`);
  }

  await f.effects.runPromise(JobsService.use((service) => service.drain()));
}

// Abstract landscape avatars: friendly, and clearly not photographs of anyone.
async function avatar(browser: Browser, [sky, sun, hills]: [string, string, string]) {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 } });

  await page.setContent(`<body style="margin:0"><svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="${sun}"/></linearGradient></defs>
    <rect width="256" height="256" fill="url(#s)"/>
    <circle cx="170" cy="110" r="38" fill="#fff" opacity="0.75"/>
    <path d="M0 190 Q60 120 120 170 T256 150 V256 H0Z" fill="${hills}" opacity="0.65"/>
    <path d="M0 220 Q80 170 160 205 T256 200 V256 H0Z" fill="${hills}"/></svg></body>`);

  const jpg = await page.screenshot({ type: 'jpeg', quality: 90 });
  await page.close();

  return jpg;
}

// Connected services with fictional credentials, and the latest rides delivered to them.
function connect(f: Fixture, player: number) {
  const activities = f.effects.runSync(ActivitiesService);
  const connections = f.effects.runSync(ConnectionsService);
  const documents = f.effects.runSync(DocumentsService);
  f.effects.runSync(connections.save(player, 'strava', ['184203', 'not-a-real-strava-secret']));
  f.effects.runSync(documents.put(player, 'strava_token.txt', 'not-a-real-token'));
  f.effects.runSync(connections.save(player, 'garmin', ['maja@example.com', 'not-a-real-garmin-password']));
  f.effects.runSync(documents.put(player, 'garth/oauth1_token.json', '{}'));
  f.effects.runSync(connections.save(player, 'intervals', ['5551234', 'not-a-real-intervals-key']));
  f.settings.save(player, { 'workouts.trainingpeaks.bridgeFolder': '/srv/trainingpeaks' });

  const upload = f.accounts.db.prepare(
    "INSERT INTO activity_upload (activity_id, provider, state, updated_at) VALUES (?, ?, 'sent', ?)",
  );

  for (const activity of f.effects.runSync(activities.own(player)).slice(0, 3))
    for (const provider of ['strava', 'garmin', 'intervals']) upload.run(Number(activity.id), provider, Date.now());
}

async function listen(t: TestContext, fetch: (request: Request) => Response | Promise<Response>) {
  const server = serve({ fetch, hostname: '127.0.0.1', port: 0 });

  if (!server.listening) await once(server, 'listening');
  t.after(() => server.close());

  return `http://127.0.0.1:${Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Finite }))(server.address()).port}`;
}

async function shot(page: Page, name: string) {
  await page.evaluate(async () => {
    // Browser callback runs in the page's DOM environment.
    const { document } = globalThis;
    await document.fonts.ready;
  });
  await page.screenshot({ path: path.resolve(out, `${name}.png`) });
  console.log(`media/screenshots/${name}.png`);
}

await test('capture README screenshots', { timeout: 120_000 }, async (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('External requests are disabled while capturing screenshots');
  });

  const f = runtimeFixture(t);
  t.mock.method(f.effects.runSync(WorkoutsService), 'syncWorkoutsAutomatically', () => Effect.void);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  mkdirSync(out, { recursive: true });
  const users: User[] = [];

  for (const rider of riders) {
    const user = await f.accounts.create(rider.name, password, rider.username);
    users.push(user);

    if (rider.avatar)
      writeFileSync(
        path.resolve(f.profiles.folder(user.player_id), 'avatarLarge.jpg'),
        await avatar(browser, rider.avatar),
      );
  }

  await f.effects.runPromise(
    ManagementService.use((management) =>
      management.setup({
        mode: 'existing',
        key: f.effects.runSync(ManagementService.use((management) => management.issueSetupKey()))!,
        player_id: users[0]!.player_id,
        password,
      }),
    ),
  );

  // Setup grants the administrator role, which starts a new identity.
  const maja = f.accounts.get(users[0]!.player_id)!;
  await seedActivities(f, maja, riders[0]!);
  connect(f, maja.player_id);

  // Tomás is out on a ride, and Lena's account is switched off.
  const tomas = BigInt(users[1]!.player_id);
  f.world.online.set(tomas, create(PlayerStateSchema, { id: tomas, worldTime: worldTime() + 3_600_000n }));
  f.accounts.db.prepare('UPDATE user SET enabled = 0 WHERE player_id = ?').run(users[4]!.player_id);

  const game = await listen(t, f.app.fetch);
  const web = await listen(t, createWebApp(f).fetch);

  // The launcher runs in the game's small window.
  const launcher = await browser.newPage({ viewport: { width: 800, height: 460 }, deviceScaleFactor: 2 });
  await launcher.goto(`${game}/login/`);
  await shot(launcher, 'launcher-riders');
  await launcher.getByRole('button', { name: 'Maja Lindqvist' }).click();
  await launcher.getByLabel('Password', { exact: true }).fill(password);
  await launcher.getByRole('button', { name: 'Sign in' }).click();
  await launcher.waitForURL('**/user/**');
  await shot(launcher, 'launcher-dashboard');

  // Reduced motion shows charts fully drawn instead of mid-animation.
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    reducedMotion: 'reduce',
  });

  await page.goto(`${web}/sign-in`);
  await page.getByLabel('Login name', { exact: true }).fill(maja.username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Profile', exact: true }).waitFor();
  await page.getByLabel('Birthday').fill('1991-04-23');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.getByRole('status').waitFor();

  for (const [route, name] of [
    ['/', 'profile'],
    ['/activities', 'activities'],
    ['/integrations', 'integrations'],
    ['/settings', 'settings'],
    ['/manage', 'users'],
  ] as const) {
    await page.goto(`${web}${route}`);
    await page.waitForLoadState('networkidle');
    await shot(page, `webapp-${name}`);
  }
});
