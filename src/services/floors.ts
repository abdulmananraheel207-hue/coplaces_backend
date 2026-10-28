import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { floorObjects, locationFloors, resources } from '../db/schema.js';
import { HttpError, conflict, notFound } from '../lib/errors.js';
import type { AuthUser } from '../lib/auth.js';

/** Every floor a location has: the ones named for it, plus any a space or object already sits on. */
export async function floorsOf(db: Db, locationId: string): Promise<string[]> {
  const [named, spaces, objects] = await Promise.all([
    db.select({ n: locationFloors.name }).from(locationFloors).where(eq(locationFloors.locationId, locationId)).all(),
    db.select({ n: resources.floor, status: resources.status }).from(resources).where(eq(resources.locationId, locationId)).all(),
    db.select({ n: floorObjects.floor }).from(floorObjects).where(eq(floorObjects.locationId, locationId)).all(),
  ]);
  return [...new Set([...named.map((x) => x.n), ...spaces.filter((x) => x.status !== 'retired').map((x) => x.n), ...objects.map((x) => x.n)])];
}

/**
 * Refuses adding floors past the package's limit. Saving something onto a floor that already exists is always fine,
 * and so is staying put when a location is already over a limit that was lowered later.
 */
export async function assertFloorsWithinLimit(db: Db, user: AuthUser, locationId: string, adding: string[]) {
  const limit = user.org?.maxFloors;
  if (limit == null) return;
  const have = new Set(await floorsOf(db, locationId));
  const fresh = [...new Set(adding)].filter((f) => !have.has(f));
  if (fresh.length && have.size + fresh.length > limit) {
    throw new HttpError(403, `Your ${user.org!.packageName} package allows up to ${limit} floor${limit === 1 ? '' : 's'} per location. Ask Coplaces about upgrading to add more.`, { limit: 'floors' });
  }
}

/** Remembers floors by name so they exist before anything is placed on them. */
export async function saveFloors(db: Db, locationId: string, names: string[]) {
  const have = new Set(await floorsOf(db, locationId));
  for (const name of new Set(names)) if (!have.has(name)) await db.insert(locationFloors).values({ locationId, name }).onConflictDoNothing().run();
}

/** Removes a floor, but only an empty one: rooms, desks and objects must be taken off it first. */
export async function deleteFloor(db: Db, locationId: string, name: string) {
  const spaces = (await db.select({ status: resources.status }).from(resources).where(and(eq(resources.locationId, locationId), eq(resources.floor, name))).all()).filter((x) => x.status !== 'retired');
  const objects = await db.select({ id: floorObjects.id }).from(floorObjects).where(and(eq(floorObjects.locationId, locationId), eq(floorObjects.floor, name))).all();
  if (spaces.length || objects.length) throw conflict('That floor still has rooms, desks or other things on it. Remove them in Edit floor plan first.');
  const gone = await db.delete(locationFloors).where(and(eq(locationFloors.locationId, locationId), eq(locationFloors.name, name))).returning({ id: locationFloors.id }).get();
  if (!gone) throw notFound('Floor');
}
