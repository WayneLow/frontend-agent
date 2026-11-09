// Catalogue derived from the original CineFlow demo data (cineflow-data.js, Apache-2.0).
// Shared by the page and the backend (which re-validates purchases against it).

import { movies as baseMovies } from './cineflow-data.js';

export const SHOW_DAYS = 14;

const localDate = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString('en-CA'); // local YYYY-MM-DD
};

/** Every movie plays every listed showtime on each of the next SHOW_DAYS days (as in the original demo). */
export const DATES = Array.from({ length: SHOW_DAYS }, (_, i) => localDate(i));

export const CITIES = ['Dubai', 'London', 'Montpelier', 'New York', 'Paris', 'Sydney', 'Tokyo'];

export const GENRES = ['action', 'comedy', 'horror', 'drama', 'sci-fi', 'thriller'];

export const MOVIES = baseMovies.map(({ showtimes, ...m }) => ({ ...m, times: showtimes, dates: DATES }));
