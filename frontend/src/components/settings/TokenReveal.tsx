"use client";

// One-time reveal of a freshly created API token, held at page level.
//
// The raw secret exists only in the create response. The token section is
// keyed by team and remounts on a team switch, so a reveal kept inside the
// section is lost when the team changes while the create request is in
// flight. The page therefore owns the reveals (React state only: no storage,
// URL or log), each tagged with the team it was created in, and renders a
// reveal either inside that team's section or, after a switch, as a banner
// naming the team it belongs to.

import { useCallback, useEffect, useRef, useState } from "react";
import AlertBanner from "../ui/AlertBanner";
import { Button } from "../ui/Button";
import { CopyableCode } from "../ui/CopyableCode";

// Mask after a delay so an abandoned tab does not leave the secret on screen
// indefinitely.
export const REVEAL_MASK_DELAY_MS = 30_000;

export interface TokenReveal {
  teamId: string;
  teamName: string;
  rawToken: string;
  masked: boolean;
}

export interface TokenReveals {
  reveals: TokenReveal[];
  /** Show a new token's secret; a newer one for the same team replaces it. */
  show: (teamId: string, teamName: string, rawToken: string) => void;
  dismiss: (teamId: string) => void;
  /** Show the masked secret again (no new mask timer, as before). */
  unmask: (teamId: string) => void;
  /** Restart the mask timer (after the secret was copied). */
  startMask: (teamId: string) => void;
}

export function useTokenReveals(): TokenReveals {
  const [reveals, setReveals] = useState<TokenReveal[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const alive = useRef(true);

  const clearTimer = useCallback((teamId: string) => {
    const t = timers.current.get(teamId);
    if (t) clearTimeout(t);
    timers.current.delete(teamId);
  }, []);

  const startMask = useCallback(
    (teamId: string) => {
      clearTimer(teamId);
      timers.current.set(
        teamId,
        setTimeout(() => {
          timers.current.delete(teamId);
          setReveals((prev) =>
            prev.map((r) => (r.teamId === teamId ? { ...r, masked: true } : r)),
          );
        }, REVEAL_MASK_DELAY_MS),
      );
    },
    [clearTimer],
  );

  const show = useCallback(
    (teamId: string, teamName: string, rawToken: string) => {
      // A create that resolves after the page is gone must not keep a secret
      // (or a timer) alive.
      if (!alive.current) return;
      setReveals((prev) => [
        ...prev.filter((r) => r.teamId !== teamId),
        { teamId, teamName, rawToken, masked: false },
      ]);
      startMask(teamId);
    },
    [startMask],
  );

  const dismiss = useCallback(
    (teamId: string) => {
      clearTimer(teamId);
      setReveals((prev) => prev.filter((r) => r.teamId !== teamId));
    },
    [clearTimer],
  );

  const unmask = useCallback(
    (teamId: string) => {
      clearTimer(teamId);
      setReveals((prev) =>
        prev.map((r) => (r.teamId === teamId ? { ...r, masked: false } : r)),
      );
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
  const { teamId } = reveal;
  return (
    <AlertBanner
      tone="success"
      title={
        foreign
          ? `Token created for ${reveal.teamName} (shown once)`
          : "Token created (shown once)"
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
        onCopy={() => api.startMask(teamId)}
      />
      {reveal.masked && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => api.unmask(teamId)}
          className="settings-token-reveal"
        >
          Reveal
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => api.dismiss(teamId)}
        className="settings-token-reveal"
      >
        Dismiss
      </Button>
    </AlertBanner>
  );
}
