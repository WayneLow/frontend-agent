// CineFlow UI (adapted from the original demo's script.js, Apache-2.0) + its WebMCP tools.
// State lives in the URL like the original: ?city=&genre= and #movie/<id>.
// Buying is a human action: the agent can prefill checkout, only the user clicks Buy.

import { CITIES, DATES, GENRES, MOVIES } from './movies.js';
import { registerTool } from './webmcp.js';

const PRICE_PER_TICKET = 12;

let currentCity = '';
let currentGenre = 'all';
let currentSelectedDate = DATES[0];
let selection = null; // { movie, date, time } once checkout is open

const $ = (sel) => document.querySelector(sel);
const el = (tag, className, text) => Object.assign(document.createElement(tag), { className, textContent: text ?? '' });
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const dateLabel = (date, opts) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, opts);

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.remove('translate-y-20', 'opacity-0');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('translate-y-20', 'opacity-0'), 3000);
}

function filteredMovies() {
  return MOVIES.filter((m) => (currentGenre === 'all' || m.genre === currentGenre) && (!currentCity || m.locations.includes(currentCity)));
}

// --- Rendering ------------------------------------------------------------------

function renderGenreBar() {
  $('#genre-bar').replaceChildren(...['all', ...GENRES].map((g) => {
    const active = g === currentGenre;
    const btn = el('button', `px-4 py-1 rounded-full font-medium ${active ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300'}`,
      g === 'all' ? 'All' : g === 'sci-fi' ? 'Sci-Fi' : capitalize(g));
    btn.onclick = () => setGenre(g);
    return btn;
  }));
}

function renderMovies() {
  const list = filteredMovies();
  $('#movie-count').textContent = `(${list.length})`;
  const grid = $('#movie-grid');
  if (!list.length) {
    grid.replaceChildren(el('div', 'col-span-full py-20 text-center text-gray-500', `No movies found in ${currentCity || 'this area'}.`));
    return;
  }
  grid.replaceChildren(...list.map((movie) => {
    const card = el('div', 'bg-gray-800 rounded-xl overflow-hidden cursor-pointer hover:ring-2 hover:ring-blue-500 transition');
    card.onclick = () => { window.location.hash = `movie/${movie.id}`; };
    const img = Object.assign(el('img', 'w-full aspect-[2/3] object-cover'), { src: movie.poster, alt: movie.title, loading: 'lazy' });
    const body = el('div', 'p-3');
    body.append(el('h3', 'font-bold text-lg leading-tight truncate', movie.title), el('p', 'text-sm text-gray-400 capitalize', movie.genre));
    card.append(img, body);
    return card;
  }));
}

function renderMovieDetails(id) {
  const movie = MOVIES.find((m) => m.id === id);
  if (!movie) {
    window.location.hash = '';
    return;
  }
  if (currentCity && !movie.locations.includes(currentCity)) {
    showToast(`${movie.title} is not showing in ${currentCity}.`);
    window.location.hash = '';
    return;
  }

  $('#home-view').classList.add('hidden');
  $('#details-view').classList.remove('hidden');
  $('#detail-title').textContent = movie.title;
  $('#detail-genre').textContent = capitalize(movie.genre);
  $('#detail-locations-text').textContent = `Playing in: ${movie.locations.join(', ')}`;
  $('#detail-poster').src = movie.poster;
  $('#detail-poster').alt = movie.title;

  $('#date-selector').replaceChildren(...movie.dates.map((date) => {
    const active = date === currentSelectedDate;
    const btn = el('button', `w-16 flex-shrink-0 snap-start flex flex-col items-center justify-center py-2 rounded-xl transition ${
      active ? 'bg-blue-600 text-white shadow-lg' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}`);
    btn.append(
      el('span', 'text-xs font-normal uppercase tracking-wider', dateLabel(date, { weekday: 'short' })),
      el('span', 'text-lg font-bold leading-none my-1', dateLabel(date, { day: 'numeric' })),
      el('span', 'text-xs font-normal', dateLabel(date, { month: 'short' })),
    );
    btn.onclick = () => {
      currentSelectedDate = date;
      selection = null;
      renderMovieDetails(id);
    };
    return btn;
  }));

  $('#showtime-list').replaceChildren(...movie.times.map((time) => {
    const active = selection?.movie.id === movie.id && selection.date === currentSelectedDate && selection.time === time;
    const btn = el('button', `px-4 py-2 rounded-lg font-medium transition ${active ? 'bg-green-600' : 'bg-gray-800 hover:bg-gray-700'}`, time);
    btn.onclick = () => initiateCheckout(movie, currentSelectedDate, time);
    return btn;
  }));

  $('#checkout-section').classList.toggle('hidden', selection?.movie.id !== movie.id);
}

function initiateCheckout(movie, date, time) {
  selection = { movie, date, time };
  currentSelectedDate = date;
  $('#checkout-result').textContent = '';
  $('#checkout-section').classList.remove('prefilled');
  const label = dateLabel(date, { weekday: 'short', month: 'short', day: 'numeric' });
  $('#checkout-time').textContent = `${label} at ${time}`;
  updateTotal();
  renderMovieDetails(movie.id);
  $('#checkout-section').scrollIntoView({ behavior: 'smooth' });
  showToast(`Checkout started for ${label} at ${time}`);
}

function updateTotal() {
  $('#checkout-total').textContent = `Total: $${(Number($('#qty').value) || 0) * PRICE_PER_TICKET}`;
}

function updateStateFromUrl() {
  const params = new URLSearchParams(window.location.search);
  currentCity = CITIES.includes(params.get('city')) ? params.get('city') : '';
  currentGenre = GENRES.includes(params.get('genre')) ? params.get('genre') : 'all';
  $('#location-text').textContent = currentCity || 'Select Location';
  $('#city-input').value = currentCity;
  renderGenreBar();

  if (window.location.hash.startsWith('#movie/')) {
    renderMovieDetails(window.location.hash.replace('#movie/', ''));
  } else {
    selection = null;
    $('#details-view').classList.add('hidden');
    $('#home-view').classList.remove('hidden');
    $('#checkout-section').classList.add('hidden');
  }
  renderMovies();
}

function setLocation(city) {
  const url = new URL(window.location);
  if (city) url.searchParams.set('city', city);
  else url.searchParams.delete('city');

  // If we are on details view and the movie isn't in this city, go back home
  if (window.location.hash.startsWith('#movie/')) {
    const movie = MOVIES.find((m) => m.id === window.location.hash.replace('#movie/', ''));
    if (movie && city && !movie.locations.includes(city)) {
      url.hash = '';
      showToast(`${movie.title} is not playing in ${city}.`);
    }
  }
  window.history.pushState({}, '', url);
  updateStateFromUrl();
}

function setGenre(genre) {
  const url = new URL(window.location);
  if (genre && genre !== 'all') url.searchParams.set('genre', genre);
  else url.searchParams.delete('genre');
  url.hash = '';
  window.history.pushState({}, '', url);
  updateStateFromUrl();
}

// --- Event listeners ----------------------------------------------------------------

$('#city-input').append(...CITIES.map((c) => new Option(c, c)));
$('#location-btn').onclick = () => $('#location-modal').classList.remove('hidden');
$('#close-modal-btn').onclick = () => $('#location-modal').classList.add('hidden');
$('#update-location-btn').onclick = () => {
  if ($('#city-input').value) {
    setLocation($('#city-input').value);
    $('#location-modal').classList.add('hidden');
  }
};
$('#clear-location-btn').onclick = () => {
  setLocation('');
  $('#location-modal').classList.add('hidden');
};
$('#back-btn').onclick = () => { window.location.hash = ''; };
$('#qty').oninput = updateTotal;
$('#checkout-cancel').onclick = () => {
  selection = null;
  $('#checkout-section').classList.add('hidden');
  renderMovieDetails(window.location.hash.replace('#movie/', ''));
};

$('#checkout-form').onsubmit = async (e) => {
  e.preventDefault();
  const { movie, date, time } = selection;
  const result = $('#checkout-result');
  $('#checkout-section').classList.remove('prefilled');
  const res = await fetch('/api/tickets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ movie_id: movie.id, date, time, quantity: Number($('#qty').value), name: $('#name').value, email: $('#email').value }),
  });
  const data = await res.json();
  result.className = `mt-3 ${res.ok ? 'text-green-400' : 'text-orange-400'}`;
  result.textContent = res.ok
    ? `✅ Booked ${data.booking.id}: ${data.booking.quantity} × ${data.booking.title}, $${data.booking.total}`
    : `❌ ${data.error}`;
};

window.addEventListener('hashchange', updateStateFromUrl);
updateStateFromUrl();

// --- WebMCP tools ----------------------------------------------------------------

const DAY_LABELS = ['today', 'tomorrow'];

registerTool({
  name: 'update_location',
  description: `Sets the user's city, which filters the movies shown. Supported cities: ${CITIES.join(', ')}.`,
  inputSchema: {
    type: 'object',
    properties: { city: { type: 'string', enum: CITIES, description: 'The city to switch to.' } },
    required: ['city'],
  },
  execute: ({ city }) => {
    if (!CITIES.includes(city)) return { status: 'error', message: `Unsupported city. Use one of: ${CITIES.join(', ')}` };
    setLocation(city);
    showToast(`🤖 Location set to ${city}`);
    return { status: 'success', message: `Location set to ${city}.` };
  },
});

registerTool({
  name: 'query_content',
  description: 'Filters the movie catalog by genre (in the current city, if one is set) and returns matching movies with ids, cities and showtimes. Omit genre to show all.',
  inputSchema: {
    type: 'object',
    properties: { genre: { type: 'string', enum: GENRES, description: 'Genre to filter by.' } },
  },
  annotations: { readOnlyHint: true },
  execute: ({ genre }) => {
    setGenre(GENRES.includes(genre) ? genre : 'all');
    showToast(`🤖 Showing ${genre ?? 'all'} movies${currentCity ? ` in ${currentCity}` : ''}`);
    return {
      status: 'success',
      city: currentCity || 'all cities',
      // Every movie plays its times on every date below. Dates are labelled so the
      // model doesn't have to do date arithmetic for "today"/"tomorrow".
      dates: DATES.map((date, i) => ({ date, day: DAY_LABELS[i] ?? dateLabel(date, { weekday: 'long' }) })),
      movies: filteredMovies().map(({ id, title, genre: g, locations, times }) => ({ id, title, genre: g, locations, times })),
    };
  },
});

registerTool({
  name: 'select_showtime',
  description: 'Opens a movie and selects a showtime to start checkout. Use ids, dates and times returned by query_content.',
  inputSchema: {
    type: 'object',
    properties: {
      movie_id: { type: 'string', description: 'Movie id, e.g. "123".' },
      date: { type: 'string', description: 'Date in YYYY-MM-DD.' },
      time: { type: 'string', description: 'Showtime exactly as listed, e.g. "8:00 PM".' },
    },
    required: ['movie_id', 'date', 'time'],
  },
  execute: ({ movie_id, date, time }) => {
    const movie = MOVIES.find((m) => m.id === movie_id);
    if (!movie) return { status: 'error', message: `No movie with id ${movie_id}` };
    if (currentCity && !movie.locations.includes(currentCity)) return { status: 'error', message: `${movie.title} is not showing in ${currentCity}` };
    if (!movie.dates.includes(date) || !movie.times.includes(time)) {
      return { status: 'error', message: `Invalid showtime. Dates: ${movie.dates[0]} to ${movie.dates.at(-1)}; times: ${movie.times.join(', ')}` };
    }
    window.history.pushState({}, '', `${window.location.pathname}${window.location.search}#movie/${movie.id}`);
    initiateCheckout(movie, date, time);
    return { status: 'success', message: `Checkout opened for ${movie.title} on ${date} at ${time}.` };
  },
});

registerTool({
  name: 'prefill_checkout',
  description: 'Fills in the checkout form (ticket quantity, name, email) for the selected showtime. It does NOT buy: the user must review and click Buy themselves. Call select_showtime first.',
  inputSchema: {
    type: 'object',
    properties: {
      quantity: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of tickets.' },
      name: { type: 'string', description: "Ticket holder's full name." },
      email: { type: 'string', description: 'Email for the e-tickets.' },
    },
    required: ['quantity'],
  },
  execute: ({ quantity, name, email }) => {
    if (!selection) return { status: 'error', message: 'No showtime selected. Call select_showtime first.' };
    $('#qty').value = quantity;
    if (name) $('#name').value = name;
    if (email) $('#email').value = email;
    updateTotal();
    $('#checkout-section').classList.add('prefilled');
    $('#checkout-section').scrollIntoView({ behavior: 'smooth' });
    showToast('🤖 Checkout prefilled. Review and click Buy');
    const missing = ['name', 'email'].filter((f) => !$(`#${f}`).value);
    return {
      status: 'success',
      message: `Checkout prefilled for ${quantity} ticket(s). The purchase is NOT complete: the user must review and click Buy.`,
      missing_fields: missing,
    };
  },
});
