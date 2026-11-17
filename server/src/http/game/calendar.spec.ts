import { calendarLabels } from '#src/http/game/calendar';
import assert from 'node:assert/strict';
import { test } from 'node:test';

await test('calendar keeps both worlds and changes at the schedule offset', () => {
  const maps = `<MapSchedule><appointments>
<appointment map="LONDON" start="2026-11-16T00:01-04"/>
<appointment map="FRANCE" start="2026-11-18T00:01-04"/>
</appointments></MapSchedule>`;

  const roads = `<PortalRoads><PortalRoadSchedule><appointments>
<appointment road="1" world="10" portal="0" start="2026-11-01T00:01-04"/>
<appointment road="2" world="1" portal="0" start="2026-11-15T00:01-04"/>
<appointment road="3" world="1" portal="0" start="2026-11-18T00:01-04"/>
</appointments></PortalRoadSchedule></PortalRoads>`;

  const climbs = [
    { road: '1', name: 'Monthly climb' },
    { road: '2', name: 'Current climb' },
    { road: '3', name: 'Next climb' },
  ];

  assert.deepEqual(calendarLabels(maps, roads, climbs, Date.parse('2026-11-18T04:00:59Z')), {
    map: 'London / Yorkshire (Calendar)',
    climb: 'Monthly climb / Current climb (Calendar)',
  });
  assert.deepEqual(calendarLabels(maps, roads, climbs, Date.parse('2026-11-18T04:01:00Z')), {
    map: 'France / Paris (Calendar)',
    climb: 'Monthly climb / Next climb (Calendar)',
  });
});
