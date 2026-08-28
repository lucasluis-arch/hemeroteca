#!/usr/bin/env node
/**
 * Chequeo matutino del Heraldo de Goma.
 * Lee data.json (el mismo archivo que usa el panel), revisa el estado del día
 * de hoy (hora Uruguay) según las mismas reglas de secciones por día de semana,
 * y envía un correo con lo que falta (o confirmando que está todo listo).
 */
import { readFileSync } from 'node:fs';

const WEEKDAYS_ES = ['Domingo','Lunes','Martes','Miércoles','Jueves','Viernes','Sábado'];
const MONTHS_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

// Debe coincidir exactamente con SECUNDARIA_CONFIG del panel (index.html).
const SECUNDARIA_CONFIG = {
  1: [{ key: 'matilde', label: 'Editorial de Opinión — Matilde' }],
  5: [{ key: 'martin', label: 'Editorial de Opinión — Martín' }],
  2: [{ key: 'noticias', label: 'Noticias del Mundo' }],
  4: [{ key: 'noticias', label: 'Noticias del Mundo' }],
  3: [{ key: 'donde_estoy', label: 'El Dónde Estoy' }],
  6: [{ key: 'animales', label: 'Publicación de Animales (Angela)' }],
  0: [{ key: 'fonoteca', label: 'Fonoteca' }],
};

const DATA_PATH = process.env.DATA_PATH || 'data.json';

// Uruguay está fijo en UTC-3 todo el año (sin horario de verano desde 2015).
function montevideoNow() {
  const shifted = new Date(Date.now() - 3 * 60 * 60 * 1000);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    wd: shifted.getUTCDay(),
  };
}
function isoFromParts(y, m, d) {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function buildChecklist(day, weekday) {
  const secItems = SECUNDARIA_CONFIG[weekday] || [];
  return [
    { label: 'Efemérides del día', status: day ? day.efemerides.status : 'pendiente' },
    ...secItems.map((item) => ({
      label: item.label,
      status: day && day.secundaria && day.secundaria[item.key] ? day.secundaria[item.key].status : 'pendiente',
    })),
    { label: 'Tira cómica', status: day ? day.tira.status : 'pendiente' },
    { label: 'Galería de Goma', status: day ? day.galeria.status : 'pendiente' },
  ];
}

function loadData() {
  try {
    return JSON.parse(readFileSync(DATA_PATH, 'utf8'));
  } catch (e) {
    console.error(`No se pudo leer ${DATA_PATH}: ${e.message}`);
    return { days: {} };
  }
}

async function sendEmail(subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!apiKey || !to) {
    throw new Error('Faltan las variables RESEND_API_KEY o NOTIFY_EMAIL');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'El Heraldo de Goma <onboarding@resend.dev>',
      to: [to],
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Resend respondió ${res.status}: ${text.slice(0, 300)}`);
  }
  console.log('Correo enviado a ' + to);
}

async function main() {
  const mv = montevideoNow();
  const todayISO = isoFromParts(mv.y, mv.m, mv.d);
  const longLabel = `${WEEKDAYS_ES[mv.wd]} ${mv.d} de ${MONTHS_ES[mv.m - 1]}`;

  const raw = loadData();
  const day = (raw.days || {})[todayISO];
  const isSkip = !!(day && day.skip);
  const checklist = buildChecklist(day, mv.wd);
  const missing = checklist.filter((i) => i.status !== 'listo');
  const ready = isSkip || missing.length === 0;

  let subject, html;
  if (isSkip) {
    subject = `⏸ Heraldo — hoy (${todayISO}) es día sin publicación`;
    html = `<p>Hoy, <strong>${longLabel}</strong>, está marcado como día sin publicación. No hace falta preparar nada.</p>`;
  } else if (ready) {
    subject = `✅ Heraldo — ${todayISO} listo`;
    html = `<p>Todo listo para hoy, <strong>${longLabel}</strong>. Buen día de publicación.</p>`;
  } else {
    subject = `⚠️ Heraldo — faltan ${missing.length} cosa${missing.length === 1 ? '' : 's'} para hoy`;
    const items = missing
      .map((i) => `<li>${i.label} — <em>${i.status === 'progreso' ? 'en curso' : 'pendiente'}</em></li>`)
      .join('');
    html = `<p>Para hoy, <strong>${longLabel}</strong>, todavía falta:</p><ul>${items}</ul>`;
    if (!day) html += '<p><em>No hay ningún dato cargado para hoy todavía.</em></p>';
  }

  if (process.env.PAGES_URL) {
    html += `<p><a href="${process.env.PAGES_URL}">Abrir el panel de control</a></p>`;
  }

  await sendEmail(subject, html);
}

main().catch((e) => {
  console.error('Error: ' + e.message);
  process.exit(1);
});
