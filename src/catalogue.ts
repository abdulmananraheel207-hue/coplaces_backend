import { RESOURCE_KINDS } from './db/schema.js';

type Kind = (typeof RESOURCE_KINDS)[number];

/**
 * The looks a room, desk or office can have in the floor plan. The first of each list is the default,
 * and an empty style on a resource means that default. The web app keeps its own copy with names, sizes
 * and pictures; the keys must match.
 */
export const STYLES = {
  room: ['meeting', 'phone_booth', 'huddle', 'training', 'studio', 'interview', 'focus', 'video_call'],
  corporate_room: ['boardroom', 'training_hall', 'event_hall'],
  hot_desk: ['standard', 'standing', 'corner', 'day_office'],
  dedicated_desk: ['standard', 'standing', 'corner', 'team_pod'],
  office: ['standard', 'executive'],
  storage: ['locker', 'mailbox', 'parking'],
} as const satisfies Record<Kind, readonly string[]>;

export const isValidStyle = (kind: Kind, style: string) => style === '' || (STYLES[kind] as readonly string[]).includes(style);

/** Spaces given to a member for a period instead of being booked: reserved desks, offices, lockers, mailboxes and parking. */
export const isAssigned = (kind: string) => kind === 'dedicated_desk' || kind === 'office' || kind === 'storage';

/** Every kind of space can be rented to one member on a contract. A bookable one then stops being bookable by anyone else. */
export const isRentable = (_kind: string) => true;

/** Rooms booked by the hour. Corporate rooms are billed at their own rate and do not use a plan's included minutes. */
export const isHourly = (kind: string) => kind === 'room' || kind === 'corporate_room';
