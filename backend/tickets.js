// Ticket bookings. The backend is the source of truth: every input from the
// browser (or from an agent) is re-validated against the catalogue here.

import crypto from 'node:crypto';
import { MOVIES } from '../public/movies.js';

export const PRICE_PER_TICKET = 12;
const REFUND_CUTOFF_MS = 2 * 60 * 60 * 1000; // refunds allowed until 2h before the show

const bookings = new Map(); // id -> booking

function showStart(date, time) {
  const [, h, m, ampm] = time.match(/^(\d{1,2}):(\d{2}) (AM|PM)$/);
  const hours = (Number(h) % 12) + (ampm === 'PM' ? 12 : 0);
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(y, mo - 1, d, hours, Number(m));
}

const fail = (message) => Object.assign(new Error(message), { status: 400 });

export function buyTickets(userId, { movie_id, date, time, quantity, name, email }) {
  const movie = MOVIES.find((m) => m.id === movie_id);
  if (!movie) throw fail('Unknown movie');
  if (!movie.dates.includes(date) || !movie.times.includes(time)) throw fail('Invalid showtime');
  if (showStart(date, time) <= new Date()) throw fail('That showtime has already started');
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) throw fail('Quantity must be 1–10');
  if (!name?.trim()) throw fail('Name is required');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email ?? '')) throw fail('A valid email is required');

  const booking = {
    id: `BK-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    userId,
    movie_id,
    title: movie.title,
    date,
    time,
    quantity: qty,
    name: name.trim(),
    email,
    total: qty * PRICE_PER_TICKET,
    status: 'confirmed',
    createdAt: new Date().toISOString(),
  };
  bookings.set(booking.id, booking);
  return view(booking);
}

function view(b) {
  const { userId, ...rest } = b;
  return { ...rest, refundable: refundCheck(userId, b.id).ok };
}

export function listBookings(userId) {
  return [...bookings.values()].filter((b) => b.userId === userId).map(view);
}

/** Policy check. Bookings belonging to someone else are reported as not found. */
export function refundCheck(userId, bookingId) {
  const b = bookings.get(bookingId);
  if (!b || b.userId !== userId) return { ok: false, reason: 'Booking not found' };
  if (b.status !== 'confirmed') return { ok: false, reason: `Booking is already ${b.status}` };
  if (showStart(b.date, b.time) - Date.now() < REFUND_CUTOFF_MS) {
    return { ok: false, reason: 'Refunds close 2 hours before the show' };
  }
  return { ok: true, booking: b };
}

export function getBooking(userId, bookingId) {
  const b = bookings.get(bookingId);
  return b?.userId === userId ? view(b) : undefined;
}

export function refundBooking(userId, bookingId, reason) {
  const check = refundCheck(userId, bookingId);
  if (!check.ok) return { status: 'error', message: check.reason };
  check.booking.status = 'refunded';
  check.booking.refundReason = reason;
  return { status: 'success', booking_id: bookingId, refunded_amount: check.booking.total, reason };
}
