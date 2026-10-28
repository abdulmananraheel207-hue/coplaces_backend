import bcrypt from 'bcryptjs';
import { and, asc, eq, gt, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { contractPeople, contractSpaces, contracts, members, resourceAssignments, resources, users } from '../db/schema.js';
import { loadLocation } from '../lib/access.js';
import { assertLocation, orgUsage, type AuthUser } from '../lib/auth.js';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors.js';
import { addDays, todayIn } from '../lib/time.js';
import { monthlyTotal, type PricingTerms } from './contractPricing.js';
import { assignSpace } from './contracts.js';
import { syncUser } from './devices.js';

type Contract = typeof contracts.$inferSelect;

/**
 * Company contracts: a company, its employees, and the spaces they use. Employees are real members (so bookings and
 * check-in work as usual), switched off until the contract starts. The first person is the contact the invoices go to.
 */

export interface PersonInput {
  name: string;
  email: string;
  phone: string;
  password: string;
  deskResourceId: string | null;
  joinDate?: string | undefined;
}

export interface CompanyContractInput {
  locationId: string;
  companyName: string;
  companyEmail: string;
  companyPhone: string;
  startDate: string;
  endDate: string | null;
  pricingMode: 'per_member' | 'fixed';
  pricePerMemberCents: number;
  extraMemberCents: number;
  fixedPriceCents: number;
  advanceCents: number;
  depositCents: number;
  notes: string;
  spaceIds: string[];
  people: PersonInput[];
}

const DESK_KINDS = ['hot_desk', 'dedicated_desk'];

export const termsOf = (c: Contract): PricingTerms => ({
  pricingMode: c.pricingMode,
  pricePerMemberCents: c.pricePerMemberCents,
  extraMemberCents: c.extraMemberCents,
  fixedPriceCents: c.fixedPriceCents,
  startDate: c.startDate,
  endDate: c.endDate,
});

async function load(db: Db, actor: AuthUser, id: string) {
  const c = await db.select().from(contracts).where(eq(contracts.id, id)).get();
  if (!c) throw notFound('Contract');
  assertLocation(actor, c.locationId);
  return c;
}

/** The seats the contract's shared spaces have between them. */
export async function seatsOf(db: Db, contractId: string) {
  const rows = await db.select({ capacity: resources.capacity }).from(contractSpaces).innerJoin(resources, eq(resources.id, contractSpaces.resourceId)).where(eq(contractSpaces.contractId, contractId)).all();
  return rows.reduce((s, r) => s + r.capacity, 0);
}

/** Keeps the contract's monthly figure (what the contract list shows) in step with who is on it. */
export async function refreshRent(t: Db, contractId: string) {
  const c = (await t.select().from(contracts).where(eq(contracts.id, contractId)).get())!;
  const people = await t.select().from(contractPeople).where(and(eq(contractPeople.contractId, c.id), isNull(contractPeople.leaveDate))).all();
  const { totalCents } = monthlyTotal(termsOf(c), people.map((p) => ({ hasDesk: !!p.deskResourceId })), await seatsOf(t, c.id));
  await t.update(contracts).set({ rentCents: totalCents }).where(eq(contracts.id, c.id)).run();
}

/** Stops an assignment after `endDate`, or removes it if it never had a day of its own. */
export async function stopAssignment(t: Db, assignmentId: string | null, endDate: string, today: string) {
  if (!assignmentId) return;
  // An end date is the last day the holder has the space, so ending it today frees it from today.
  const last = endDate <= today ? addDays(endDate, -1) : endDate;
  const a = await t.select().from(resourceAssignments).where(eq(resourceAssignments.id, assignmentId)).get();
  if (a && last < a.startDate) await t.delete(resourceAssignments).where(eq(resourceAssignments.id, a.id)).run();
  else if (a) await t.update(resourceAssignments).set({ endDate: last }).where(eq(resourceAssignments.id, a.id)).run();
}

/** The last day a member is here: from then on they are cancelled and cannot sign in. */
async function closeMember(t: Db, memberId: string, lastDay: string, today: string) {
  const m = await t.select().from(members).where(eq(members.id, memberId)).get();
  if (!m) return;
  const gone = lastDay <= today;
  await t.update(members).set({ endDate: lastDay, ...(gone ? { status: 'cancelled' as const } : {}) }).where(eq(members.id, memberId)).run();
  if (gone) await t.update(users).set({ active: false }).where(eq(users.id, m.userId)).run();
}

async function checkSpaces(t: Db, locationId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await t.select().from(resources).where(inArray(resources.id, ids)).all();
  if (rows.length !== new Set(ids).size || rows.some((r) => r.locationId !== locationId)) throw notFound('Space');
  const gone = rows.find((r) => r.status === 'retired');
  if (gone) throw badRequest(`${gone.name} has been retired and cannot be rented`);
}

async function checkDesks(t: Db, locationId: string, ids: string[]) {
  if (new Set(ids).size !== ids.length) throw badRequest('Two people cannot be given the same desk');
  await checkSpaces(t, locationId, ids);
  const rows = ids.length ? await t.select().from(resources).where(inArray(resources.id, ids)).all() : [];
  const bad = rows.find((r) => !DESK_KINDS.includes(r.kind));
  if (bad) throw badRequest(`${bad.name} is not a desk. Only hot desks and dedicated desks can be given to one person`);
}

/** The package may cap how many members a space has; an employee is a member. */
async function assertRoomFor(t: Db, actor: AuthUser, n: number) {
  const org = actor.org;
  if (!org || org.maxMembers === null || n === 0) return;
  const used = (await orgUsage(t, org.id)).members;
  if (used + n > org.maxMembers) {
    throw new HttpError(403, `Your ${org.packageName} package allows up to ${org.maxMembers} members. This would bring you to ${used + n}. Ask Coplaces about upgrading to add more.`, { limit: 'members' });
  }
}

async function checkEmails(t: Db, emails: string[]) {
  const lower = emails.map((e) => e.toLowerCase());
  if (new Set(lower).size !== lower.length) throw badRequest('Two people have the same email');
  for (const email of lower) if (await t.select({ id: users.id }).from(users).where(eq(users.email, email)).get()) throw conflict(`${email} is already in use`);
}

async function insertUserAndMember(t: Db, c: { locationId: string; companyName: string; startDate: string; endDate: string | null }, organizationId: string, p: PersonInput, hash: string, live: boolean, joinDate: string) {
  const user = await t.insert(users).values({ organizationId, name: p.name, email: p.email.toLowerCase(), phone: p.phone, role: 'member', passwordHash: hash, active: live }).returning().get();
  const member = await t
    .insert(members)
    .values({ userId: user.id, locationId: c.locationId, company: c.companyName, planId: null, status: live ? 'active' : 'paused', startDate: joinDate, endDate: c.endDate })
    .returning()
    .get();
  return { user, member };
}

export async function createCompanyContract(db: Db, actor: AuthUser, input: CompanyContractInput) {
  assertLocation(actor, input.locationId);
  const loc = await loadLocation(db, input.locationId);
  if (input.endDate && input.endDate < input.startDate) throw badRequest('End date is before start date');
  if (!input.people.length) throw badRequest('Add at least one person');
  const desks = input.people.flatMap((p) => (p.deskResourceId ? [p.deskResourceId] : []));
  if (desks.length < input.people.length && !input.spaceIds.length) throw badRequest('Choose a space for the people who do not have a desk of their own');
  await checkSpaces(db, loc.id, input.spaceIds);
  await checkDesks(db, loc.id, desks);
  if (desks.some((d) => input.spaceIds.includes(d))) throw badRequest("A desk cannot be both a shared space and one person's desk");
  await checkEmails(db, input.people.map((p) => p.email));
  await assertRoomFor(db, actor, input.people.length);
  const hashes = await Promise.all(input.people.map((p) => bcrypt.hash(p.password, 10)));

  const id = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const first = await insertUserAndMember(t, { ...input, locationId: loc.id }, loc.organizationId, input.people[0]!, hashes[0]!, false, input.startDate);
    const contract = await t
      .insert(contracts)
      .values({
        locationId: loc.id,
        memberId: first.member.id,
        resourceId: null,
        startDate: input.startDate,
        endDate: input.endDate,
        advanceCents: input.advanceCents,
        depositCents: input.depositCents,
        notes: input.notes,
        companyName: input.companyName,
        companyEmail: input.companyEmail,
        companyPhone: input.companyPhone,
        pricingMode: input.pricingMode,
        pricePerMemberCents: input.pricePerMemberCents,
        extraMemberCents: input.extraMemberCents,
        fixedPriceCents: input.fixedPriceCents,
        createdById: actor.id,
      })
      .returning()
      .get();
    await t.insert(contractPeople).values({ contractId: contract.id, memberId: first.member.id, deskResourceId: input.people[0]!.deskResourceId, joinDate: input.startDate }).run();
    for (const [i, p] of input.people.slice(1).entries()) {
      const made = await insertUserAndMember(t, { ...input, locationId: loc.id }, loc.organizationId, p, hashes[i + 1]!, false, input.startDate);
      await t.insert(contractPeople).values({ contractId: contract.id, memberId: made.member.id, deskResourceId: p.deskResourceId, joinDate: input.startDate }).run();
    }
    for (const resourceId of new Set(input.spaceIds)) await t.insert(contractSpaces).values({ contractId: contract.id, resourceId }).run();
    await refreshRent(t, contract.id);
    return contract.id;
  });
  return (await db.select().from(contracts).where(eq(contracts.id, id)).get())!;
}

/** Draft to active for a company: employees can sign in, and the shared spaces and each person's desk are handed over. */
export async function activateCompany(t: Db, actor: AuthUser, c: Contract) {
  const people = await t.select().from(contractPeople).where(and(eq(contractPeople.contractId, c.id), isNull(contractPeople.leaveDate))).all();
  if (!people.length) throw badRequest('Add at least one person first');
  for (const p of people) {
    const m = (await t.select().from(members).where(eq(members.id, p.memberId)).get())!;
    await t.update(members).set({ status: 'active' }).where(eq(members.id, p.memberId)).run();
    await t.update(users).set({ active: true }).where(eq(users.id, m.userId)).run();
  }
  // The contact holds the shared spaces; anyone on the contract may still book them.
  for (const s of await t.select().from(contractSpaces).where(eq(contractSpaces.contractId, c.id)).all()) {
    const a = await assignSpace(t, actor, { resourceId: s.resourceId, memberId: c.memberId, startDate: c.startDate, endDate: c.endDate });
    await t.update(contractSpaces).set({ assignmentId: a.id }).where(eq(contractSpaces.id, s.id)).run();
  }
  for (const p of people) {
    if (!p.deskResourceId) continue;
    const a = await assignSpace(t, actor, { resourceId: p.deskResourceId, memberId: p.memberId, startDate: p.joinDate > c.startDate ? p.joinDate : c.startDate, endDate: c.endDate });
    await t.update(contractPeople).set({ assignmentId: a.id }).where(eq(contractPeople.id, p.id)).run();
  }
}

/** After a contract starts, attendance devices learn of the employees, who can only sign in from now. */
export async function syncContractPeople(db: Db, contractId: string) {
  const rows = await db.select({ userId: members.userId }).from(contractPeople).innerJoin(members, eq(members.id, contractPeople.memberId)).where(eq(contractPeople.contractId, contractId)).all();
  for (const r of rows) await syncUser(db, r.userId);
}

/** Ending a company contract frees its spaces and desks and lets every remaining employee go. */
export async function endCompanyParts(t: Db, c: Contract, endDate: string, today: string) {
  for (const s of await t.select().from(contractSpaces).where(eq(contractSpaces.contractId, c.id)).all()) await stopAssignment(t, s.assignmentId, endDate, today);
  for (const p of await t.select().from(contractPeople).where(and(eq(contractPeople.contractId, c.id), isNull(contractPeople.leaveDate))).all()) {
    await stopAssignment(t, p.assignmentId, endDate, today);
    await t.update(contractPeople).set({ leaveDate: endDate }).where(eq(contractPeople.id, p.id)).run();
    await closeMember(t, p.memberId, endDate, today);
  }
}

/** Throws a draft company contract away, with the employee logins that were made for it. */
export function discardCompanyDraft(db: Db, actor: AuthUser, id: string) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const c = await load(t, actor, id);
    if (c.status !== 'draft' || !c.companyName) throw conflict('Only a draft company contract can be discarded');
    if (c.advanceReceivedAt || c.depositStatus !== 'pending') throw conflict('Money was already received on this contract');
    const people = await t.select().from(contractPeople).where(eq(contractPeople.contractId, c.id)).all();
    await t.delete(contractPeople).where(eq(contractPeople.contractId, c.id)).run();
    await t.delete(contractSpaces).where(eq(contractSpaces.contractId, c.id)).run();
    await t.delete(contracts).where(eq(contracts.id, c.id)).run();
    for (const p of people) {
      const m = await t.select().from(members).where(eq(members.id, p.memberId)).get();
      await t.delete(members).where(eq(members.id, p.memberId)).run();
      if (m) await t.delete(users).where(eq(users.id, m.userId)).run();
    }
  });
}

/** Adds an employee to a draft or running company contract. On a running one they can sign in at once and get their desk. */
export async function addPerson(db: Db, actor: AuthUser, contractId: string, input: PersonInput) {
  const hash = await bcrypt.hash(input.password, 10);
  const made = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const c = await load(t, actor, contractId);
    if (!c.companyName) throw badRequest('This is not a company contract');
    if (c.status === 'ended' || c.status === 'cancelled') throw conflict(`This contract is ${c.status}`);
    const live = c.status === 'active';
    const loc = await loadLocation(t, c.locationId);
    const today = todayIn(loc.timezone);
    const joinDate = input.joinDate ?? (live && today > c.startDate ? today : c.startDate);
    if (joinDate < c.startDate || (c.endDate && joinDate > c.endDate)) throw badRequest('The join date must be within the contract');
    await checkEmails(t, [input.email]);
    await checkDesks(t, c.locationId, input.deskResourceId ? [input.deskResourceId] : []);
    const current = await t.select({ r: contractPeople.deskResourceId }).from(contractPeople).where(and(eq(contractPeople.contractId, c.id), isNull(contractPeople.leaveDate))).all();
    if (input.deskResourceId && current.some((x) => x.r === input.deskResourceId)) throw badRequest('That desk is already on this contract');
    if (!input.deskResourceId && !(await seatsOf(t, c.id))) throw badRequest('This contract has no shared space, so give the person a desk');
    await assertRoomFor(t, actor, 1);
    const { user, member } = await insertUserAndMember(t, c, loc.organizationId, input, hash, live, joinDate);
    const person = await t.insert(contractPeople).values({ contractId: c.id, memberId: member.id, deskResourceId: input.deskResourceId, joinDate }).returning().get();
    if (live && input.deskResourceId) {
      const a = await assignSpace(t, actor, { resourceId: input.deskResourceId, memberId: member.id, startDate: joinDate, endDate: c.endDate });
      await t.update(contractPeople).set({ assignmentId: a.id }).where(eq(contractPeople.id, person.id)).run();
    }
    await refreshRent(t, c.id);
    return { user, person };
  });
  if (made.user.active) await syncUser(db, made.user.id);
  return made.person;
}

/** Takes an employee off a contract. A draft forgets them; a running one lets them go on a date, freeing their desk and their login. */
export function removePerson(db: Db, actor: AuthUser, contractId: string, personId: string, date?: string) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const c = await load(t, actor, contractId);
    if (c.status === 'ended' || c.status === 'cancelled') throw conflict(`This contract is ${c.status}`);
    const person = await t.select().from(contractPeople).where(and(eq(contractPeople.id, personId), eq(contractPeople.contractId, c.id))).get();
    if (!person) throw notFound('Person');
    const others = await t.select().from(contractPeople).where(and(eq(contractPeople.contractId, c.id), isNull(contractPeople.leaveDate), ne(contractPeople.id, person.id))).orderBy(asc(contractPeople.joinDate)).all();
    if (!others.length) throw conflict('A contract needs at least one person. End the contract instead.');
    if (c.memberId === person.memberId) await t.update(contracts).set({ memberId: others[0]!.memberId }).where(eq(contracts.id, c.id)).run();
    if (c.status === 'draft') {
      const m = (await t.select().from(members).where(eq(members.id, person.memberId)).get())!;
      await t.delete(contractPeople).where(eq(contractPeople.id, person.id)).run();
      // The contract may still point at them if it was their membership that was the contact: it was moved above.
      await t.delete(members).where(eq(members.id, m.id)).run();
      await t.delete(users).where(eq(users.id, m.userId)).run();
    } else {
      const today = todayIn((await loadLocation(t, c.locationId)).timezone);
      const last = date ?? today;
      if (last < person.joinDate) throw badRequest('That is before they joined');
      await stopAssignment(t, person.assignmentId, last, today);
      await t.update(contractPeople).set({ leaveDate: last }).where(eq(contractPeople.id, person.id)).run();
      await closeMember(t, person.memberId, last, today);
    }
    await refreshRent(t, c.id);
  });
}

/** Moves the end of a company contract later, keeping the same spaces and desks, if nobody else has them by then. */
export function extendContract(db: Db, actor: AuthUser, id: string, endDate: string) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const c = await load(t, actor, id);
    if (c.status !== 'active' && c.status !== 'draft') throw conflict(`This contract is ${c.status}`);
    if (!c.endDate) throw badRequest('This contract has no end date, so it is already open ended');
    if (endDate <= c.endDate) throw badRequest('The new end date must be after the current one');
    const held = [
      ...(await t.select({ a: contractSpaces.assignmentId }).from(contractSpaces).where(eq(contractSpaces.contractId, c.id)).all()).map((x) => x.a),
      ...(await t.select({ a: contractPeople.assignmentId }).from(contractPeople).where(and(eq(contractPeople.contractId, c.id), isNull(contractPeople.leaveDate))).all()).map((x) => x.a),
      c.assignmentId,
    ].filter((x): x is string => !!x);
    for (const aid of held) {
      const a = await t.select().from(resourceAssignments).where(eq(resourceAssignments.id, aid)).get();
      if (!a || a.endDate !== c.endDate) continue;
      const clash = await t
        .select({ id: resourceAssignments.id })
        .from(resourceAssignments)
        .where(and(eq(resourceAssignments.resourceId, a.resourceId), ne(resourceAssignments.id, a.id), lte(resourceAssignments.startDate, endDate), or(isNull(resourceAssignments.endDate), gt(resourceAssignments.endDate, c.endDate))))
        .get();
      if (clash) {
        const name = (await t.select({ n: resources.name }).from(resources).where(eq(resources.id, a.resourceId)).get())?.n ?? 'A space';
        throw conflict(`${name} is already taken for part of that time, so the contract cannot be extended`);
      }
      await t.update(resourceAssignments).set({ endDate }).where(eq(resourceAssignments.id, a.id)).run();
    }
    for (const p of await t.select().from(contractPeople).where(and(eq(contractPeople.contractId, c.id), isNull(contractPeople.leaveDate))).all()) await t.update(members).set({ endDate }).where(eq(members.id, p.memberId)).run();
    return t.update(contracts).set({ endDate }).where(eq(contracts.id, c.id)).returning().get();
  });
}

/** Changes which spaces a draft company contract shares. */
export function setContractSpaces(db: Db, actor: AuthUser, id: string, resourceIds: string[]) {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const c = await load(t, actor, id);
    if (c.status !== 'draft' || !c.companyName) throw conflict('The spaces can only be changed while the contract is a draft');
    await checkSpaces(t, c.locationId, resourceIds);
    const people = await t.select({ r: contractPeople.deskResourceId }).from(contractPeople).where(eq(contractPeople.contractId, c.id)).all();
    if (resourceIds.some((r) => people.some((p) => p.r === r))) throw badRequest("A desk cannot be both a shared space and one person's desk");
    if (people.some((p) => !p.r) && !resourceIds.length) throw badRequest('Some people share a space, so keep at least one');
    await t.delete(contractSpaces).where(eq(contractSpaces.contractId, c.id)).run();
    for (const resourceId of new Set(resourceIds)) await t.insert(contractSpaces).values({ contractId: c.id, resourceId }).run();
    await refreshRent(t, c.id);
  });
}
