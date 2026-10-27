"use client";

// One-time reveal of a freshly created API token, held at page level.
//
// The raw secret exists only in the create response. The token section is
// keyed by team and remounts on a team switch, so a reveal kept inside the
// section is lost when the team changes while the create request is in
// flight. The page therefore owns the reveals (React state only: no storage,
// URL or log), each tagged with the team it was created in, and renders a
// reveal either inside that team's section or, after a switch, as a banner
// naming the team it belongs to. Every create gets its own reveal (several
// can be open at once, also for one team) and every reveal names its token,
// so two secrets are never mistaken for each other.

import { useCallback, useEffect, useRef, useState } from "react";
import AlertBanner from "../ui/AlertBanner";
import { Button } from "../ui/Button";
import { CopyableCode } from "../ui/CopyableCode";

// Mask after a delay so an abandoned tab does not leave the secret on screen
// indefinitely.
export const REVEAL_MASK_DELAY_MS = 30_000;

export interface TokenReveal {
  /** One per create: concurrent creates, even for one team, never share it. */
  id: string;
  teamId: string;
  teamName: string;
  /** The name the user gave the token, so a reveal says which secret it is. */
  tokenName: string;
  rawToken: string;
  masked: boolean;
}

export interface TokenReveals {
  /** Newest reveal first (by the time its response arrived). */
  reveals: TokenReveal[];
  /**
   * Show a created token's secret as its own reveal; nothing is replaced.
   * `masked` starts the reveal masked (Reveal available) for a secret that an
   * earlier view already masked; default is shown in clear.
   */
  show: (
    teamId: string,
    teamName: string,
    tokenName: string,
    rawToken: string,
    masked?: boolean,
  ) => void;
  dismiss: (id: string) => void;
  /** Show the masked secret again (and drop any mask timer, as before). */
  unmask: (id: string) => void;
  /** Restart the mask timer (after the secret was copied). */
  startMask: (id: string) => void;
}

export function useTokenReveals(): TokenReveals {
  const [reveals, setReveals] = useState<TokenReveal[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const alive = useRef(true);
  const seq = useRef(0);

  const clearTimer = useCallback((id: string) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
  }, []);

  const startMask = useCallback(
    (id: string) => {
      clearTimer(id);
      timers.current.set(
        id,
        setTimeout(() => {
          timers.current.delete(id);
          setReveals((prev) => prev.map((r) => (r.id === id ? { ...r, masked: true } : r)));
        }, REVEAL_MASK_DELAY_MS),
      );
    },
    [clearTimer],
  );

  const show = useCallback(
    (teamId: string, teamName: string, tokenName: string, rawToken: string, masked = false) => {
      // A create that resolves after the page is gone must not keep a secret
      // (or a timer) alive.
      if (!alive.current) return;
      seq.current += 1;
      const id = `reveal-${seq.current}`;
      setReveals((prev) => [{ id, teamId, teamName, tokenName, rawToken, masked }, ...prev]);
      // An already masked secret needs no timer; Reveal shows it again.
      if (!masked) startMask(id);
    },
    [startMask],
  );

  const dismiss = useCallback(
    (id: string) => {
      clearTimer(id);
      setReveals((prev) => prev.filter((r) => r.id !== id));
    },
    [clearTimer],
  );

  const unmask = useCallback(
    (id: string) => {
      clearTimer(id);
      setReveals((prev) => prev.map((r) => (r.id === id ? { ...r, masked: false } : r)));
    },
    [clearTimer],
  );

  useEffect(() => {
    alive.current = true;
    const pending = timers.current;
    return () => {
      alive.current = false;
      pending.forEach((t) => clearTimeout(t));
      pending.clear();
    };
  }, []);

  return { reveals, show, dismiss, unmask, startMask };
}

interface TokenRevealBannerProps {
  reveal: TokenReveal;
  api: TokenReveals;
  /**
   * Name the team in the title and say the token is not in the current team's
   * list. Set when the reveal is shown outside its own team's section.
   */
  foreign?: boolean;
}

export function TokenRevealBanner({ reveal, api, foreign = false }: TokenRevealBannerProps) {
  const { id } = reveal;
  return (
    <AlertBanner
      tone="success"
      title={
        foreign
          ? `Token "${reveal.tokenName}" created for ${reveal.teamName} (shown once)`
          : `Token "${reveal.tokenName}" created (shown once)`
      }
    >
      {foreign && (
        // No muted description class here: the banner's own text colour is the
        // one that meets contrast on the tinted background in both schemes.
        <p>
          This token belongs to <strong>{reveal.teamName}</strong>, the team you
          created it in. It is not in the token list of the team you are viewing now.
        </p>
      )}
      <CopyableCode
        value={reveal.rawToken}
        masked={reveal.masked}
        onCopy={() => api.startMask(id)}
      />
      {reveal.masked && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => api.unmask(id)}
          className="settings-token-reveal"
        >
          Reveal
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => api.dismiss(id)}
        className="settings-token-reveal"
      >
        Dismiss
      </Button>
    </AlertBanner>
  );
}
