// Orata — stage channels: a voice room where only the speakers talk. Everybody else listens, can raise a hand, and is invited up by a moderator.
import { voice, emitTo, audienceOf, canIn } from './core.js';

export const MAX_SPEAKERS = 10;
export const isStage = (ch) => ch?.type === 'stage';
/** Server channels people can join with voice: voice channels and stages. */
export const isVoiceLike = (ch) => ch?.type === 'voice' || ch?.type === 'stage';
/** Who brings people on and off the stage: whoever manages the channel or moderates members (the owner and administrators included). */
export const isStageMod = (userId, ch) => canIn(userId, ch, 'MANAGE_CHANNELS') || canIn(userId, ch, 'MODERATE_MEMBERS');
export const speakersOf = (room) => [...room.values()].filter((s) => s.speaker);

export function broadcastVoiceState(ch, st) { emitTo(audienceOf(ch), 'voice_state_update', { channelId: ch.id, userId: st.userId, state: st }); }

/** What a person's voice state looks like when they walk onto a stage: in the audience, muted — unless they are the moderator opening an empty stage. */
export function stageJoinState(ch, userId, room, base) {
  const st = { ...base, muted: true, video: false, screen: false, speaker: false };
  if (isStageMod(userId, ch) && canIn(userId, ch, 'SPEAK') && !speakersOf(room).length) st.speaker = true;
  return st;
}
/** Who a newcomer must set up a connection with: speakers hear everybody, the audience only needs the speakers. */
export const peersFor = (ch, room, st) => [...room.values()].filter((o) => !isStage(ch) || st.speaker || o.speaker).map((o) => o.userId);
/** Audio and video only flow where a speaker is involved: two audience members never connect to each other. */
export function mayLink(ch, room, a, b) {
  if (!isStage(ch)) return true;
  return !!(room.get(a)?.speaker || room.get(b)?.speaker);
}

/** Puts a member on or off the stage. Returns what went wrong, or null. */
export function setSpeaker(ch, userId, on) {
  const room = voice.get(ch.id); const st = room?.get(userId);
  if (!st) return 'They aren’t in this stage';
  if (!!st.speaker === on) return null;
  if (on) {
    if (!canIn(userId, ch, 'SPEAK')) return 'They don’t have permission to speak here';
    if (speakersOf(room).length >= MAX_SPEAKERS) return `A stage holds up to ${MAX_SPEAKERS} speakers`;
    st.speaker = true; delete st.hand; delete st.handAt;
  } else {
    st.speaker = false; st.muted = true; st.video = false; st.screen = false;
  }
  broadcastVoiceState(ch, st);
  return null;
}
export function setHand(ch, userId, up) {
  const st = voice.get(ch.id)?.get(userId); if (!st || st.speaker) return;
  if (up && canIn(userId, ch, 'SPEAK')) { if (st.hand) return; st.hand = true; st.handAt = Date.now(); }
  else if (st.hand) { delete st.hand; delete st.handAt; }
  else return;
  broadcastVoiceState(ch, st);
}
/** After permissions changed: whoever may no longer speak steps down and lowers their hand. */
export function revalidateStage(ch) {
  const room = voice.get(ch.id); if (!room) return;
  for (const st of [...room.values()]) {
    if (canIn(st.userId, ch, 'SPEAK')) continue;
    if (st.speaker) setSpeaker(ch, st.userId, false); else setHand(ch, st.userId, false);
  }
}
