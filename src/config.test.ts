import { describe, expect, it } from 'vitest';
import {
  DPR_CAP,
  REDUCED_MOTION_SPEED_LEVEL,
  REDUCED_MOTION_STREAK_TIME_SECONDS,
  SHIP_DEFAULT_SPEED_LEVEL,
  STAR_STREAK_TIME_SECONDS,
  initialSpeedSettings,
} from './config';

describe('config', () => {
  it('caps the device pixel ratio at 2', () => {
    expect(DPR_CAP).toBe(2);
  });
});

describe('initialSpeedSettings', () => {
  it('returns the reduced speed level and streak time under reduced motion', () => {
    expect(initialSpeedSettings(true)).toEqual({
      speedLevel: REDUCED_MOTION_SPEED_LEVEL,
      streakTime: REDUCED_MOTION_STREAK_TIME_SECONDS,
    });
  });

  it('returns the defaults otherwise', () => {
    expect(initialSpeedSettings(false)).toEqual({
      speedLevel: SHIP_DEFAULT_SPEED_LEVEL,
      streakTime: STAR_STREAK_TIME_SECONDS,
    });
  });

  it('the reduced settings are slower and shorter, and still leave room to speed up', () => {
    expect(REDUCED_MOTION_SPEED_LEVEL).toBeLessThan(SHIP_DEFAULT_SPEED_LEVEL);
    expect(REDUCED_MOTION_STREAK_TIME_SECONDS).toBeLessThan(STAR_STREAK_TIME_SECONDS);
  });
});
