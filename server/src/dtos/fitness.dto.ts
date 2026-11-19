import { FitnessGoalSetting } from '#src/enum';
import { Schema } from 'effect';
import { withDefault, withLazyDefault } from '#src/schema';

export const goalSchema = Schema.Struct({
  weekGoalTSS: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(withDefault(200)),
  weekGoalCalories: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(withDefault(2000)),
  weekGoalKjs: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(withDefault(2000)),
  weekGoalDistanceKilometers: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(withDefault(100)),
  weekGoalDistanceMiles: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(withDefault(62.14)),
  weekGoalTimeMinutes: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)).pipe(withDefault(180)),
  currentGoalSetting: Schema.Enum(FitnessGoalSetting).pipe(withDefault('DISTANCE')),
  currentGoalSource: Schema.String.pipe(withDefault('MANUAL')),
  lastUpdated: Schema.String.pipe(withLazyDefault(() => new Date().toISOString())),
});
