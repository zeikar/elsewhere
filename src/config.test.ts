import { describe, expect, it } from 'vitest';
import { DPR_CAP } from './config';

describe('config', () => {
  it('caps the device pixel ratio at 2', () => {
    expect(DPR_CAP).toBe(2);
  });
});
