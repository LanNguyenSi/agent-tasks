"use client";

import { useSyncExternalStore } from "react";

// false on the server and during hydration, true once the client has taken
// over. Portals need the browser DOM, so they wait for it. A store read
// instead of a mount effect that sets state, so there is no extra effect pass.
const subscribe = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function useMounted(): boolean {
  return useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot);
}
