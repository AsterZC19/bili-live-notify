import { randomUUID } from 'node:crypto';
import type { LiveEvent, RoomState, Session, Snapshot } from './model.js';

export const OFFLINE_DELAY = 30_000;
export const TITLE_DELAY = 20_000;
export interface Transition { state: RoomState; sessions: Session[]; events: LiveEvent[] }
export function advance(previous: RoomState | null, input: Snapshot, maxGapMs = OFFLINE_DELAY): Transition {
  const snapshot = structuredClone(input);
  const now = snapshot.observedAt;
  if (previous && now < previous.lastObservedAt) return { state: structuredClone(previous), sessions: [], events: [] };
  const sessions: Session[] = [];
  const events: LiveEvent[] = [];
  const state: RoomState = previous ? structuredClone(previous) : {
    uid: snapshot.uid, snapshot, live: false, session: null,
    offlineSince: null, titleCandidate: null, confirmedTitle: snapshot.title, lastObservedAt: now,
  };
  const gap = now - state.lastObservedAt > maxGapMs;
  const save = (session: Session) => sessions.push(structuredClone(session));
  const start = (announce: boolean) => {
    const validStart = snapshot.startedAt !== null && snapshot.startedAt >= (state.lastEndedAt ?? 0)
      ? snapshot.startedAt : null;
    state.session = {
      id: randomUUID(), uid: snapshot.uid, roomId: snapshot.roomId, name: snapshot.name,
      startedAt: validStart ?? now, startSource: validStart ? 'api' : 'observed',
      upstreamStart: validStart, endedAt: null, durationSeconds: null, endSource: null,
      firstObservedAt: now, lastLiveAt: now, firstOfflineAt: null,
      initialTitle: snapshot.title, finalTitle: snapshot.title, status: 'live',
      initialArea: structuredClone(snapshot.area), finalArea: structuredClone(snapshot.area),
      joinedLate: !announce, interrupted: false,
    };
    state.live = true; state.offlineSince = null; state.titleCandidate = null;
    state.confirmedTitle = snapshot.title;
    if (announce) events.push({ kind: 'start', snapshot, session: structuredClone(state.session) });
  };
  const finish = (unknown: boolean, announce: boolean) => {
    const session = state.session!;
    session.firstOfflineAt ??= state.offlineSince;
    session.endedAt = unknown ? null : session.firstOfflineAt;
    session.durationSeconds = session.endedAt === null ? null
      : Math.max(0, Math.floor((session.endedAt - session.startedAt) / 1000));
    session.endSource = unknown ? 'unknown' : 'observed';
    session.status = unknown ? 'incomplete' : 'ended';
    if (session.endedAt !== null) state.lastEndedAt = session.endedAt;
    session.interrupted ||= unknown;
    save(session);
    if (announce) events.push({ kind: 'end', snapshot, session: structuredClone(session) });
    state.live = false; state.session = null; state.offlineSince = null; state.titleCandidate = null;
  };
  if (snapshot.live) {
    if (!state.live || !state.session) {
      start(previous !== null);
    } else {
      const shortRecovery = state.offlineSince !== null && now - state.offlineSince < OFFLINE_DELAY && !gap;
      const expiredRecovery = state.offlineSince !== null && now - state.offlineSince >= OFFLINE_DELAY;
      const changedStart = snapshot.startedAt !== null && state.session.upstreamStart !== null &&
        snapshot.startedAt > state.session.upstreamStart;
      if (expiredRecovery || (changedStart && !shortRecovery)) {
        // The upstream start time proves a new session, but cannot tell us when the old one ended.
        finish(!expiredRecovery || gap || state.session.firstOfflineAt === null, expiredRecovery);
        start(true);
      } else {
        if (gap) state.session.interrupted = true;
        if (shortRecovery) state.session.upstreamStart = snapshot.startedAt ?? state.session.upstreamStart;
        if (state.session.startSource === 'observed' && snapshot.startedAt !== null &&
            snapshot.startedAt >= (state.lastEndedAt ?? 0)) {
          state.session.startedAt = snapshot.startedAt;
          state.session.startSource = 'api'; state.session.upstreamStart = snapshot.startedAt;
        }
        state.offlineSince = null;
        state.session.firstOfflineAt = null;
        state.session.lastLiveAt = now;
        state.session.endSource = null;
        state.session.initialArea ??= structuredClone(snapshot.area);
        state.session.finalArea = structuredClone(snapshot.area);
        if (snapshot.title === state.confirmedTitle) state.titleCandidate = null;
        else if (gap || state.titleCandidate?.value !== snapshot.title) {
          state.titleCandidate = { value: snapshot.title, since: now };
        } else if (now - state.titleCandidate.since >= TITLE_DELAY) {
          events.push({ kind: 'title', snapshot, session: structuredClone(state.session),
            oldTitle: state.confirmedTitle, newTitle: snapshot.title });
          state.confirmedTitle = snapshot.title; state.titleCandidate = null;
        }
        state.session.finalTitle = snapshot.title;
      }
    }
  } else if (state.live && state.session) {
    state.titleCandidate = null;
    if (state.offlineSince === null) {
      state.offlineSince = now;
      state.session.firstOfflineAt ??= now;
      // A missing interval makes the end unknowable, even after later offline confirmations.
      if (gap) state.session.endSource = 'unknown';
    }
    if (gap) {
      state.session.interrupted = true;
      state.session.endSource = 'unknown';
      state.offlineSince = now; // debounce needs fresh continuous observations
    }
    if (now - state.offlineSince >= OFFLINE_DELAY) {
      finish(state.session.endSource === 'unknown', true);
    }
  }
  if (state.session) save(state.session);
  state.snapshot = snapshot; state.lastObservedAt = now;
  return { state, sessions, events };
}

export function resetDebounce(state: RoomState): RoomState {
  const next = structuredClone(state);
  next.offlineSince = null; next.titleCandidate = null;
  return next;
}
