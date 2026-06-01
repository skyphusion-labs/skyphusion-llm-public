// D1 helpers for the persisted cast (v0.46.0). One row per character per
// user_email; survives across storyboards / renders so a character drawn
// once is reusable in every project.
//
// All read paths filter on user_email; writes accept a user_email argument
// and embed it in the WHERE / VALUES so the route handler does not need to
// re-check ownership separately.

import type { Env } from "./env";

export interface CastRefImage {
  key: string;
  mime: string;
}

export interface CastMember {
  id: number;
  user_email: string;
  slug: string;
  name: string;
  bible: string | null;
  portrait_key: string | null;
  portrait_mime: string | null;
  ref_keys: CastRefImage[];
  created_at: string;
  updated_at: string;
}

interface CastRow {
  id: number;
  user_email: string;
  slug: string;
  name: string;
  bible: string | null;
  portrait_key: string | null;
  portrait_mime: string | null;
  ref_keys_json: string;
  created_at: string;
  updated_at: string;
}

function parseRefKeys(raw: string | null): CastRefImage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r): r is CastRefImage =>
        r && typeof r === "object" && typeof r.key === "string" && typeof r.mime === "string"
      )
      .map((r) => ({ key: r.key, mime: r.mime }));
  } catch {
    return [];
  }
}

function rowToCast(row: CastRow): CastMember {
  return {
    id: row.id,
    user_email: row.user_email,
    slug: row.slug,
    name: row.name,
    bible: row.bible,
    portrait_key: row.portrait_key,
    portrait_mime: row.portrait_mime,
    ref_keys: parseRefKeys(row.ref_keys_json),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// URL-safe slug from a display name. Mirrors the projects-side slugify
// in src/index.ts. Empty / all-punctuation input falls back to "character".
export function slugifyCharacter(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]+/g, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "character";
}

// Allocate a slug unused by this user's other cast members. Bounded
// at 200 to surface pathological state instead of looping forever.
export async function allocateCastSlug(env: Env, userEmail: string, base: string): Promise<string> {
  let candidate = base;
  let suffix = 2;
  while (suffix < 200) {
    const existing = await env.DB.prepare(
      `SELECT id FROM cast_members WHERE user_email = ? AND slug = ? LIMIT 1`
    )
      .bind(userEmail, candidate)
      .first();
    if (!existing) return candidate;
    candidate = `${base}-${suffix}`;
    suffix++;
  }
  throw new Error(`Could not allocate cast slug after 200 attempts (base='${base}')`);
}

export async function listCastForUser(env: Env, userEmail: string): Promise<CastMember[]> {
  const result = await env.DB.prepare(
    `SELECT id, user_email, slug, name, bible, portrait_key, portrait_mime,
            ref_keys_json, created_at, updated_at
       FROM cast_members
      WHERE user_email = ?
      ORDER BY created_at DESC`
  )
    .bind(userEmail)
    .all<CastRow>();
  return (result.results || []).map(rowToCast);
}

export async function getCastById(
  env: Env,
  id: number,
  userEmail: string,
): Promise<CastMember | null> {
  const row = await env.DB.prepare(
    `SELECT id, user_email, slug, name, bible, portrait_key, portrait_mime,
            ref_keys_json, created_at, updated_at
       FROM cast_members
      WHERE id = ? AND user_email = ?
      LIMIT 1`
  )
    .bind(id, userEmail)
    .first<CastRow>();
  return row ? rowToCast(row) : null;
}

export async function createCast(
  env: Env,
  userEmail: string,
  input: { name: string; bible?: string | null },
): Promise<CastMember> {
  const baseSlug = slugifyCharacter(input.name);
  const slug = await allocateCastSlug(env, userEmail, baseSlug);
  const result = await env.DB.prepare(
    `INSERT INTO cast_members (user_email, slug, name, bible)
     VALUES (?, ?, ?, ?)
     RETURNING id, user_email, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, created_at, updated_at`
  )
    .bind(userEmail, slug, input.name, input.bible ?? null)
    .first<CastRow>();
  if (!result) throw new Error("createCast: INSERT...RETURNING produced no row");
  return rowToCast(result);
}

export async function updateCast(
  env: Env,
  id: number,
  userEmail: string,
  patch: { name?: string; bible?: string | null },
): Promise<CastMember | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    fields.push("name = ?");
    values.push(patch.name);
  }
  if (patch.bible !== undefined) {
    fields.push("bible = ?");
    values.push(patch.bible);
  }
  if (fields.length === 0) {
    return getCastById(env, id, userEmail);
  }
  fields.push("updated_at = datetime('now')");
  values.push(id, userEmail);
  const result = await env.DB.prepare(
    `UPDATE cast_members SET ${fields.join(", ")}
      WHERE id = ? AND user_email = ?
     RETURNING id, user_email, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, created_at, updated_at`
  )
    .bind(...values)
    .first<CastRow>();
  return result ? rowToCast(result) : null;
}

export async function deleteCast(
  env: Env,
  id: number,
  userEmail: string,
): Promise<CastMember | null> {
  // Caller is responsible for R2 cleanup of portrait_key + ref keys
  // BEFORE calling this; we return the row so the route handler can do it.
  const row = await getCastById(env, id, userEmail);
  if (!row) return null;
  await env.DB.prepare(
    `DELETE FROM cast_members WHERE id = ? AND user_email = ?`
  )
    .bind(id, userEmail)
    .run();
  return row;
}

export async function setPortrait(
  env: Env,
  id: number,
  userEmail: string,
  key: string,
  mime: string,
): Promise<CastMember | null> {
  const result = await env.DB.prepare(
    `UPDATE cast_members
        SET portrait_key = ?, portrait_mime = ?, updated_at = datetime('now')
      WHERE id = ? AND user_email = ?
     RETURNING id, user_email, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, created_at, updated_at`
  )
    .bind(key, mime, id, userEmail)
    .first<CastRow>();
  return result ? rowToCast(result) : null;
}

export async function clearPortrait(
  env: Env,
  id: number,
  userEmail: string,
): Promise<CastMember | null> {
  const result = await env.DB.prepare(
    `UPDATE cast_members
        SET portrait_key = NULL, portrait_mime = NULL, updated_at = datetime('now')
      WHERE id = ? AND user_email = ?
     RETURNING id, user_email, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, created_at, updated_at`
  )
    .bind(id, userEmail)
    .first<CastRow>();
  return result ? rowToCast(result) : null;
}

export async function addRef(
  env: Env,
  id: number,
  userEmail: string,
  ref: CastRefImage,
): Promise<CastMember | null> {
  const cur = await getCastById(env, id, userEmail);
  if (!cur) return null;
  const next = [...cur.ref_keys, ref];
  const result = await env.DB.prepare(
    `UPDATE cast_members
        SET ref_keys_json = ?, updated_at = datetime('now')
      WHERE id = ? AND user_email = ?
     RETURNING id, user_email, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, created_at, updated_at`
  )
    .bind(JSON.stringify(next), id, userEmail)
    .first<CastRow>();
  return result ? rowToCast(result) : null;
}

export async function removeRef(
  env: Env,
  id: number,
  userEmail: string,
  refKey: string,
): Promise<{ row: CastMember | null; removedKey: string | null }> {
  const cur = await getCastById(env, id, userEmail);
  if (!cur) return { row: null, removedKey: null };
  const next = cur.ref_keys.filter((r) => r.key !== refKey);
  if (next.length === cur.ref_keys.length) {
    return { row: cur, removedKey: null };
  }
  const result = await env.DB.prepare(
    `UPDATE cast_members
        SET ref_keys_json = ?, updated_at = datetime('now')
      WHERE id = ? AND user_email = ?
     RETURNING id, user_email, slug, name, bible, portrait_key, portrait_mime,
               ref_keys_json, created_at, updated_at`
  )
    .bind(JSON.stringify(next), id, userEmail)
    .first<CastRow>();
  return { row: result ? rowToCast(result) : null, removedKey: refKey };
}
