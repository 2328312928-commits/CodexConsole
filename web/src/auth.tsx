import { createContext, useContext } from 'react';
import type { SandboxMode } from '../../shared/codex.js';
import type { SignedInKey } from '../../shared/api.js';

/** The key this browser signed in with; the console hides what it may not do. */
export const SignedInKeyContext = createContext<SignedInKey | null>(null);

export function useSignedInKey(): SignedInKey | null {
  return useContext(SignedInKeyContext);
}

const SANDBOX_RANK: Record<SandboxMode, number> = { 'read-only': 0, 'workspace-write': 1, 'danger-full-access': 2 };

export function sandboxAllowed(key: SignedInKey | null, sandbox: SandboxMode): boolean {
  return !key || SANDBOX_RANK[sandbox] <= SANDBOX_RANK[key.maxSandbox];
}

/** Something is capped for this key: the automatic reviewer and widening approvals are off. */
export function keyCapped(key: SignedInKey | null): boolean {
  return key !== null && !(key.canAllow && key.approvals === 'ask');
}
