import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from './db.js';

/**
 * Finding a player in another club, to apply for a transfer. Club admins
 * cannot browse other clubs' players (data minimisation), so a search needs
 * the licence number, or the full name together with the date of birth.
 * Online only; returns just enough to recognise the right person.
 */

const query = z.union([
  z.object({ license_no: z.string().trim().min(2).max(40) }),
  z.object({
    first_name: z.string().trim().min(1).max(80),
    last_name: z.string().trim().min(1).max(80),
    birth_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
]);

export interface PlayerSearchHit {
  id: string;
  first_name: string;
  last_name: string;
  birth_year: number;
  club_id: string | null;
  club_name: string | null;
  open_transfer: boolean;
}

export function registerPlayerSearch(app: FastifyInstance, db: Db) {
  app.get('/api/players/search', async (req, reply) => {
    const ctx = req.user;
    if (!ctx.isFedAdmin && !ctx.clubIds.length) return reply.code(403).send({ error: 'forbidden' });
    const q = query.parse(req.query);
    const [where, params] =
      'license_no' in q
        ? ['lower(p.license_no) = lower($2)', [q.license_no]]
        : [
            'lower(p.first_name) = lower($2) and lower(p.last_name) = lower($3) and p.birth_date = $4',
            [q.first_name, q.last_name, q.birth_date],
          ];
    const rows = await db.query<PlayerSearchHit>(
      `select p.id, p.first_name, p.last_name, extract(year from p.birth_date)::int as birth_year,
              p.club_id, c.name as club_name,
              exists (select 1 from transfers t where t.player_id = p.id and t.deleted_at is null
                      and t.status in ('pending_club', 'pending_federation')) as open_transfer
       from players p left join clubs c on c.id = p.club_id
       where p.federation_id = $1 and p.deleted_at is null and ${where}
       order by p.last_name, p.first_name limit 10`,
      [ctx.federationId, ...params],
    );
    return rows.rows;
  });
}
