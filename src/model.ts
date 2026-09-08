export type Platform = 'telegram' | 'discord';
export interface Target { platform: Platform; id: string }
export interface Snapshot {
  uid: string; roomId: string; name: string; title: string;
  live: boolean; startedAt: number | null; keyframe: string | null; cover: string | null;
  observedAt: number;
}
export interface Session {
  id: string; uid: string; roomId: string; name: string;
  startedAt: number; startSource: 'api' | 'observed'; upstreamStart: number | null;
  endedAt: number | null; durationSeconds: number | null;
  endSource: 'observed' | 'unknown' | null;
  firstObservedAt: number; lastLiveAt: number; firstOfflineAt: number | null;
  initialTitle: string; finalTitle: string;
  status: 'live' | 'ended' | 'incomplete'; joinedLate: boolean; interrupted: boolean;
}
export interface RoomState {
  uid: string; snapshot: Snapshot; live: boolean; session: Session | null;
  offlineSince: number | null; titleCandidate: { value: string; since: number } | null;
  confirmedTitle: string; lastObservedAt: number;
  lastEndedAt?: number | null;
}
export interface LiveEvent {
  kind: 'start' | 'end' | 'title'; snapshot: Snapshot; session: Session;
  oldTitle?: string; newTitle?: string;
}
export interface Message { text: string; image?: string; fallbackImage?: string; url?: string }
export interface Delivery {
  id: number; target: Target; uid: string; message: Message;
  createdAt: number; attempts: number;
}
export class RemoteError extends Error {
  constructor(message: string, public retryAfterMs?: number, public permanent = false,
    public mediaInvalid = false) { super(message); }
}
export interface Sender { send(targetId: string, message: Message): Promise<void> }
