import type { TransferStatus } from './tables.js';

/**
 * Who may move a transfer to which status. Shared by the server rules and
 * the app's buttons, so both always agree.
 *
 *   pending_club        the current club releases (→ pending_federation) or refuses (→ rejected);
 *                       the receiving club can withdraw (→ cancelled); the federation can reject
 *   pending_federation  the federation approves or rejects; the receiving club can withdraw
 *
 * The federation cannot approve before the current club has released the
 * player. A player without a club starts at pending_federation.
 */

export interface TransferActor {
  isFedAdmin: boolean;
  /** Clubs this person administers. */
  clubIds: string[];
}

export interface TransferState {
  status: TransferStatus;
  from_club_id: string | null;
  to_club_id: string;
}

export function initialTransferStatus(fromClubId: string | null): TransferStatus {
  return fromClubId ? 'pending_club' : 'pending_federation';
}

export function transferActions(t: TransferState, actor: TransferActor): TransferStatus[] {
  const isFrom = !!t.from_club_id && actor.clubIds.includes(t.from_club_id);
  const isTo = actor.clubIds.includes(t.to_club_id);
  const allowed = new Set<TransferStatus>();
  if (t.status === 'pending_club') {
    if (isFrom) ['pending_federation', 'rejected'].forEach((s) => allowed.add(s as TransferStatus));
    if (isTo) allowed.add('cancelled');
    if (actor.isFedAdmin) allowed.add('rejected');
  } else if (t.status === 'pending_federation') {
    if (actor.isFedAdmin) ['approved', 'rejected'].forEach((s) => allowed.add(s as TransferStatus));
    if (isTo) allowed.add('cancelled');
  }
  return [...allowed];
}

/** Whose turn it is, for "needs your action" lists. */
export function transferAwaits(t: TransferState, actor: TransferActor): boolean {
  if (t.status === 'pending_club') return !!t.from_club_id && actor.clubIds.includes(t.from_club_id);
  if (t.status === 'pending_federation') return actor.isFedAdmin;
  return false;
}
