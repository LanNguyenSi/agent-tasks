/**
 * @deprecated Superseded by the "Workflow editor v2" section in globals.css
 * (stage F2, task 2198e44d). The old /projects/workflow route now redirects
 * to /projects/[id]/workflow; its _components/ are unused. This file is kept
 * only so the old StatesTable.tsx / TransitionsTable.tsx in this directory
 * continue to compile without import errors — those files are no longer
 * reachable at runtime.
 */

import type React from "react";

export const th: React.CSSProperties = {};
export const td: React.CSSProperties = {};
export const pill: React.CSSProperties = {};
export const inlineInput: React.CSSProperties = {};
export const inlineSelect: React.CSSProperties = {};
export const linkButton: React.CSSProperties = {};
