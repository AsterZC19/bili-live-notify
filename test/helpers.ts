import type { Snapshot } from '../src/model.js';
export const T = Date.parse('2026-09-08T01:00:00Z');
export const snap = (offset: number, overrides: Partial<Snapshot> = {}): Snapshot => ({
  uid: '100', roomId: '200', name: '测试主播', title: '标题 A', live: true,
  startedAt: T, observedAt: T + offset, keyframe: 'https://i0.hdslb.com/frame.jpg',
  cover: 'https://i0.hdslb.com/cover.jpg', ...overrides,
});
