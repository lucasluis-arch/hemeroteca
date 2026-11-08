#!/usr/bin/env node
/**
 * Chequeo matutino del Heraldo de Goma.
 * Lee data.json (el mismo archivo que usa el panel), revisa el día de hoy en
 * hora de Uruguay y manda un correo con lo que falta. Los nombres de las
 * secciones salen de data.json, así que se cambian solo desde el panel.
 */
import { readFileSync } from 'node:fs';

const DATA_PATH = process.env.DATA_PATH || 'data.json';
const DEFAULT_SECTIONS = {
  1: { label: 'Editorial (Matilde)' },
  2: { label: 'Noticias del Mundo' },
  3: { label: 'Ludo' },
  4: { label: 'Noticias del Mundo' },
  5: { label: 'Editorial (Martín)' },
  6: { label: 'El Rancho de Angela' },
  0: { label: 'Fonoteca' },
};
const COMICS = { mafalda: 'Mafalda', gaturro: 'Gaturro', garfield: 'Garfield', charlie: 'Charlie Brown' };
const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
const utc = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const weekday = (iso) => new Date(utc(iso)).getUTCDay();
const addDays = (iso, n) => { const t = new Date(utc(iso) + n * 86400000); return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
const diffDays = (a, b) => Math.round((utc(b) - utc(a)) / 86400000);

// Uruguay está fijo en UTC-3 todo el año.
function todayMontevideo() {
  const t = new Date(Date.now() - 3 * 3600000);
  return isoOf(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

// Devuelve los datos en el formato del panel actual (versión 2), aunque el
// archivo todavía esté en el formato anterior.
function normalize(raw) {
  if (!raw || typeof raw !== 'object') return { days: {}, periods: [], settings: {}, numbering: null };
  if (raw.version === 2) return raw;
  const days = {};
  for (const [iso, o] of Object.entries(raw.days || {})) {
    if (!o) continue;
    const sec = Object.values(o.secundaria || {})[0];
    days[iso] = {
      efemerides: { status: o.efemerides?.status },
      secundaria: { status: sec?.status },
      tira: { status: o.tira?.status, comic: o.tira?.comic },
      galeria: { status: o.galeria?.status, birth: o.galeria?.flagBirth, death: o.galeria?.flagDeath, name: o.galeria?.flagName },
    };
  }
  return { days, periods: raw.editionPeriods || [], settings: {}, numbering: raw.numbering || null };
}

function loadData() {
  try {
    return normalize(JSON.parse(readFileSync(DATA_PATH, 'utf8')));
  } catch (e) {
    console.error(`No se pudo leer ${DATA_PATH}: ${e.message}`);
    return normalize(null);
  }
}

const statusOf = (data, iso, sec) => data.days?.[iso]?.[sec]?.status || 'pendiente';
const findPeriod = (data, iso) => (data.periods || []).find((p) => diffDays(p.startDate, iso) >= 0 && diffDays(iso, p.endDate) >= 0) || null;
const issue = (data, pub, iso) => {
  const n = data.numbering?.[pub];
  return n && n.anchorDate ? n.anchorNumber + diffDays(n.anchorDate, iso) : null;
};
const fullyReady = (data, iso) => ['efemerides', 'secundaria', 'tira', 'galeria'].every((s) => statusOf(data, iso, s) === 'listo');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function sendEmail(subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!apiKey || !to) throw new Error('Faltan las variables RESEND_API_KEY o NOTIFY_EMAIL');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'El Heraldo de Goma <onboarding@resend.dev>', to: [to], subject, html }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend respondió ${res.status}: ${text.slice(0, 300)}`);
  }
  console.log('Correo enviado a ' + to);
}

export function buildEmail(data, iso) {
  const wd = weekday(iso);
  const sections = { ...DEFAULT_SECTIONS, ...(data.settings?.sections || {}) };
  const secLabel = sections[wd]?.label || DEFAULT_SECTIONS[wd].label;
  const day = data.days?.[iso] || {};
  const comic = COMICS[day.tira?.comic];

  const checklist = [
    { label: 'Efemérides', status: statusOf(data, iso, 'efemerides') },
    { label: secLabel, status: statusOf(data, iso, 'secundaria') },
    { label: comic ? `Tira cómica (${comic})` : 'Tira cómica', status: statusOf(data, iso, 'tira') },
    { label: 'Galería de Goma', status: statusOf(data, iso, 'galeria') },
  ];
  const missing = checklist.filter((i) => i.status !== 'listo');

  const [y, m, d] = iso.split('-').map(Number);
  const dateLabel = `${WEEKDAYS[wd]} ${d} de ${MONTHS[m - 1]}`;
  const hN = issue(data, 'heraldo', iso);
  const gN = issue(data, 'galeria', iso);
  const period = findPeriod(data, iso);
  const edition = period ? (period.type === 'tematica' ? 'temática' : 'estándar') : 'sin tramo asignado';

  let consecutive = 0;
  for (let i = 0; i < 120 && fullyReady(data, addDays(iso, i)); i++) consecutive++;

  let gapFrom = null;
  for (let i = 0; i < 14; i++) {
    if (!findPeriod(data, addDays(iso, i))) { gapFrom = addDays(iso, i); break; }
  }

  const head = hN != null ? `Heraldo N°${hN}` : 'Heraldo';
  const subject = missing.length
    ? `⚠️ ${head}: falta${missing.length === 1 ? '' : 'n'} ${missing.length} para hoy`
    : `✅ ${head}: hoy está listo`;

  let html = `<p><strong>${esc(dateLabel)}</strong>`;
  if (hN != null) html += ` · Heraldo N°${hN}`;
  if (gN != null) html += ` · Galería N°${gN} (${edition})`;
  html += '</p>';
  if (missing.length) {
    html += '<p>Todavía falta:</p><ul>' + missing.map((i) => `<li>${esc(i.label)}: ${i.status === 'progreso' ? 'en curso' : 'pendiente'}</li>`).join('') + '</ul>';
  } else {
    html += '<p>Todo listo para hoy.</p>';
  }
  if (day.galeria?.birth || day.galeria?.death) {
    const kind = [day.galeria.birth ? 'nacimiento' : '', day.galeria.death ? 'defunción' : ''].filter(Boolean).join(' y ');
    html += `<p>Galería con efeméride de artista: ${kind}${day.galeria.name ? ` de ${esc(day.galeria.name)}` : ''}.</p>`;
  }
  html += `<p>Días consecutivos completos desde hoy: ${consecutive}.</p>`;
  if (gapFrom) {
    const [, gm, gd] = gapFrom.split('-').map(Number);
    html += `<p>⚠️ La Galería no tiene tramo asignado desde el ${WEEKDAYS[weekday(gapFrom)].toLowerCase()} ${gd}/${gm}.</p>`;
  }
  if (process.env.PAGES_URL) html += `<p><a href="${esc(process.env.PAGES_URL)}">Abrir el panel</a></p>`;
  return { subject, html };
}

async function main() {
  const { subject, html } = buildEmail(loadData(), todayMontevideo());
  if (process.env.DRY_RUN) { console.log(subject + '\n' + html); return; }
  await sendEmail(subject, html);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error('Error: ' + e.message); process.exit(1); });
}
