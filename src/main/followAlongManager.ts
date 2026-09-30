import { BrowserWindow } from 'electron';
import type { AppLog } from './appLogger';
import type { TestStep } from './recordingManager';

/**
 * Owns Follow Along: links a "leader" session to a "follower" session so the
 * leader's recorded clicks/fills are relayed to and played back on the
 * follower in near real time (#255, extracted from sessionManager.ts once
 * #248/#258 had landed). It's built directly on top of RecordingManager —
 * the leader keeps recording via the exact same mechanism Tests recording
 * uses — so this class takes a narrow interface over RecordingManager
 * (`RecordingLink` below) rather than owning any recording state itself.
 */

// #258: a single-flight setTimeout loop, not setInterval — a tick function
// like relayFollowSteps awaits harvestRecordingSteps() plus follower
// playback (which can wait up to 10s for a selector), so a fixed-period
// interval could start a second tick while the first was still running,
// relaying the same step twice or relaying a stale value after a newer one
// landed. The next tick is only scheduled once the previous one has fully
// settled (resolved or rejected), and stop() cancels the pending timeout —
// a tick already in flight when stop() is called checks `stopped` before
// rescheduling, so it never reschedules after stop. Exported standalone
// (rather than left as inline scheduling logic in startFollowAlong) so it's
// unit-testable with fake timers and a hand-resolvable stub, without
// constructing a full FollowAlongManager.
export function startSingleFlightPoll(tick: () => Promise<void>, intervalMs: number): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = () => {
    if (stopped) return;
    // A caller-side rejection is expected to already be caught (so it can be
    // logged with context); this is a defensive fallback so a tick function
    // that forgets to catch its own errors still reschedules, rather than
    // silently stopping the loop or surfacing an unhandled rejection.
    tick().catch(() => {}).finally(() => {
      if (stopped) return;
      timer = setTimeout(run, intervalMs);
    });
  };
  timer = setTimeout(run, intervalMs);
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

// Pulled out as a pure function so the followAlong:stepResult payload shape
// for a mirrored navigation (#186) is unit-testable without the WebContents/
// pairing plumbing around it.
export function buildNavMirrorStepResult(
  kind: 'navigate' | 'navigate-in-page', url: string, error?: string
): { step: { type: 'navigate' | 'navigate-in-page'; url: string }; result: { success: boolean; error?: string } } {
  return {
    step: { type: kind, url },
    result: error === undefined ? { success: true } : { success: false, error },
  };
}

interface FollowPairing {
  leaderId: string;
  followerId: string;
  mirrorNavigation: boolean;
  // Maps step id → the value last relayed to the follower. 'fill' steps are
  // mutated in place as the user types (see upsertFill), so the same step id
  // must be re-relayed each time its value grows, not just once.
  relayedSteps: Map<string, string>;
  poller: { stop: () => void };
  navHandler: (_e: unknown, url: string) => void;
  navInPageHandler: (_e: unknown, url: string) => void;
}

export interface FollowAlongSessionRef {
  webContents: Electron.WebContents;
}

// Narrow interface over RecordingManager — Follow Along drives an existing
// recording session (the leader) and plays steps back on another (the
// follower) via exactly the same mechanics Tests recording/playback uses,
// rather than duplicating them.
export interface RecordingLink {
  isRecording: (id: string) => boolean;
  startRecording: (id: string) => Promise<boolean>;
  stopRecording: (id: string) => Promise<TestStep[]>;
  harvestRecordingSteps: (id: string) => Promise<void>;
  getBufferedSteps: (id: string) => TestStep[];
  playbackStep: (id: string, step: TestStep) => Promise<{ success: boolean; error?: string }>;
}

export class FollowAlongManager {
  private win: BrowserWindow;
  private log: AppLog;
  private getSession: (id: string) => FollowAlongSessionRef | undefined;
  private recording: RecordingLink;
  private followPairings = new Map<string, FollowPairing>();

  constructor(
    win: BrowserWindow,
    log: AppLog,
    getSession: (id: string) => FollowAlongSessionRef | undefined,
    recording: RecordingLink
  ) {
    this.win = win;
    this.log = log;
    this.getSession = getSession;
    this.recording = recording;
  }

  hasAnyActivePairing(): boolean {
    return this.followPairings.size > 0;
  }

  private isSessionLinked(id: string): boolean {
    for (const p of this.followPairings.values()) {
      if (p.leaderId === id || p.followerId === id) return true;
    }
    return false;
  }

  async startFollowAlong(
    leaderId: string, followerId: string, mirrorNavigation: boolean
  ): Promise<{ ok: boolean; error?: string }> {
    if (leaderId === followerId) return { ok: false, error: 'Pick two different sessions.' };
    const leader = this.getSession(leaderId);
    const follower = this.getSession(followerId);
    if (!leader || !follower) return { ok: false, error: 'Session not found.' };
    if (this.isSessionLinked(leaderId) || this.isSessionLinked(followerId)) {
      return { ok: false, error: 'One of these sessions is already part of a Follow Along link.' };
    }
    if (this.recording.isRecording(leaderId)) {
      return { ok: false, error: 'That session is already being recorded (Tests tab) — stop that first.' };
    }

    await this.recording.startRecording(leaderId);

    // Full-page and in-page navigation both mirror through here — logged via
    // the same followAlong:stepResult event the click/fill relay path uses
    // (renderer/followalong.js already falls back to step.type for a kind it
    // doesn't special-case, but gives 'navigate'/'navigate-in-page' their own
    // description), so there's no silent-success gap for the tester to
    // second-guess. Gated on mirrorNavigation like the mirroring itself —
    // nothing is emitted, let alone logged, while it's off.
    const makeNavHandler = (kind: 'navigate' | 'navigate-in-page') => (_e: unknown, url: string) => {
      const pairing = this.followPairings.get(leaderId);
      if (!pairing?.mirrorNavigation) return;
      const followerSession = this.getSession(pairing.followerId);
      if (!followerSession) return;
      if (followerSession.webContents.getURL() === url) return;
      followerSession.webContents.loadURL(url)
        .then(() => {
          this.win.webContents.send('followAlong:stepResult', {
            leaderId, followerId: pairing.followerId, ...buildNavMirrorStepResult(kind, url),
          });
        })
        .catch((err: unknown) => {
          this.win.webContents.send('followAlong:stepResult', {
            leaderId, followerId: pairing.followerId,
            ...buildNavMirrorStepResult(kind, url, err instanceof Error ? err.message : String(err)),
          });
        });
    };
    const navHandler = makeNavHandler('navigate');
    const navInPageHandler = makeNavHandler('navigate-in-page');
    leader.webContents.on('did-navigate', navHandler);
    leader.webContents.on('did-navigate-in-page', navInPageHandler);

    // silent: polls roughly every 300ms while Follow Along is active — too
    // high-frequency to log each tick, but a rejected tick still gets a warn.
    const poller = startSingleFlightPoll(
      () => this.relayFollowSteps(leaderId)
        .catch((e: unknown) => this.log.warn('sessions', 'Follow Along relay tick failed', { leaderId, error: String(e) })),
      300,
    );

    this.followPairings.set(leaderId, {
      leaderId, followerId, mirrorNavigation, relayedSteps: new Map(), poller, navHandler, navInPageHandler,
    });
    return { ok: true };
  }

  async stopFollowAlong(leaderId: string): Promise<boolean> {
    const pairing = this.followPairings.get(leaderId);
    if (!pairing) return false;
    pairing.poller.stop();
    const leader = this.getSession(leaderId);
    if (leader) {
      leader.webContents.off('did-navigate', pairing.navHandler);
      leader.webContents.off('did-navigate-in-page', pairing.navInPageHandler);
    }
    this.followPairings.delete(leaderId);
    if (this.recording.isRecording(leaderId)) await this.recording.stopRecording(leaderId);
    return true;
  }

  setFollowMirrorNavigation(leaderId: string, mirrorNavigation: boolean): boolean {
    const pairing = this.followPairings.get(leaderId);
    if (!pairing) return false;
    pairing.mirrorNavigation = mirrorNavigation;
    return true;
  }

  listFollowPairings(): { leaderId: string; followerId: string; mirrorNavigation: boolean }[] {
    return Array.from(this.followPairings.values()).map((p) => ({
      leaderId: p.leaderId, followerId: p.followerId, mirrorNavigation: p.mirrorNavigation,
    }));
  }

  private async relayFollowSteps(leaderId: string): Promise<void> {
    const pairing = this.followPairings.get(leaderId);
    if (!pairing) return;
    await this.recording.harvestRecordingSteps(leaderId);
    const steps = this.recording.getBufferedSteps(leaderId);
    for (const step of steps) {
      // Full navigations are mirrored separately (see navHandler above) — the
      // recorded 'navigate' step type only covers in-page history API calls.
      if (step.type !== 'click' && step.type !== 'fill' && step.type !== 'check') continue;
      // #242: never relay the literal '[hidden]' placeholder as a keystroke
      // onto the follower — there's no interactive pause here (unlike a
      // saved-test Run), so a sensitive fill is silently skipped rather than
      // typed; the follower's own tester types the real credential.
      if (step.type === 'fill' && step.sensitive) continue;
      const lastRelayedValue = pairing.relayedSteps.get(step.id);
      if (step.type === 'click') {
        if (lastRelayedValue !== undefined) continue;
      } else if (step.type === 'check') {
        if (lastRelayedValue === String(step.value)) continue;
      } else if (lastRelayedValue === (step.value ?? '')) {
        continue;
      }
      pairing.relayedSteps.set(step.id, step.type === 'check' ? String(step.value) : ((step.value as string) ?? ''));
      const result = await this.recording.playbackStep(pairing.followerId, step);
      this.win.webContents.send('followAlong:stepResult', {
        leaderId, followerId: pairing.followerId, step, result,
      });
    }
  }
}
