/**
 * Friendsgiving potluck backend (Google Apps Script)
 *
 * - Saves every sign-up as a row in the Google Sheet this script is attached to
 * - Emails the host every time someone adds a dish
 * - Optionally asks Claude for dish ideas (needs ANTHROPIC_API_KEY in Script Properties)
 *
 * Setup steps are in the README.
 */

const HOST_EMAIL = 'zs.zarinasheikh@gmail.com';   // where sign-up notifications go
const SHEET_NAME = 'Potluck';
const PARTY_DATE = 'Saturday, November 28';
const SITE_URL   = '';                               // optional: your invite link, shown in emails

const COURSES = {
  main: 'Mains', side: 'Sides', app: 'Starters',
  bread: 'Bread & rolls', dessert: 'Desserts', drinks: 'Drinks',
};
const DIETS = ['Vegetarian', 'Vegan', 'Gluten-free', 'Has nuts'];
const HEADERS = ['Timestamp', 'Name', 'Dish', 'Course', 'Extra guests', 'Dietary', 'Id'];

/* ---------------- HTTP entry points ---------------- */

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'list';
  if (action === 'list') return json_({ ok: true, entries: readEntries_() });
  return json_({ ok: false, error: 'unknown action' });
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return json_({ ok: false, error: 'bad json' }); }

  try {
    if (body.action === 'add')   return json_(addEntry_(body));
    if (body.action === 'ideas') return json_(ideas_(body));
    if (body.action === 'list')  return json_({ ok: true, entries: readEntries_() });
    return json_({ ok: false, error: 'unknown action' });
  } catch (err) {
    console.error(err);
    return json_({ ok: false, error: 'server error' });
  }
}

/* ---------------- Sheet ---------------- */

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(SHEET_NAME);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  return sh;
}

function readEntries_() {
  const sh = sheet_();
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  return sh.getRange(2, 1, n, HEADERS.length).getValues()
    .filter(r => r[1] && r[2])
    .map(r => ({
      ts: r[0] instanceof Date ? r[0].toISOString() : String(r[0]),
      name: String(r[1]),
      dish: String(r[2]),
      course: courseId_(r[3]),
      guests: Number(r[4]) || 0,
      diet: String(r[5] || '').split(',').map(s => s.trim()).filter(Boolean),
      id: String(r[6] || ''),
    }));
}

// The sheet stores readable course names so the host can edit rows by hand.
function courseId_(v) {
  const s = String(v || '').trim();
  if (COURSES[s]) return s;
  for (const id in COURSES) if (COURSES[id].toLowerCase() === s.toLowerCase()) return id;
  return 'side';
}

function clean_(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
}

function addEntry_(b) {
  const name = clean_(b.name, 60);
  const dish = clean_(b.dish, 80);
  const course = COURSES[b.course] ? b.course : 'side';
  const guests = Math.max(0, Math.min(30, Math.floor(Number(b.guests) || 0)));
  const diet = (Array.isArray(b.diet) ? b.diet : []).filter(d => DIETS.indexOf(d) !== -1);
  if (!name || !dish) return { ok: false, error: 'name and dish are required' };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let entry;
  try {
    entry = { ts: new Date().toISOString(), name, dish, course, guests, diet, id: Utilities.getUuid() };
    // Leading apostrophe stops Sheets from treating text like "=SUM()" or "+1" as a formula.
    const safe = s => (/^[=+\-@]/.test(s) ? "'" + s : s);
    sheet_().appendRow([new Date(), safe(name), safe(dish), COURSES[course], guests, diet.join(', '), entry.id]);
  } finally {
    lock.releaseLock();
  }

  const entries = readEntries_();
  try { notifyHost_(entry, entries); } catch (err) { console.error('email failed', err); }
  return { ok: true, entry, entries };
}

/* ---------------- Email ---------------- */

function headcount_(entries) {
  const people = {};
  entries.forEach(e => {
    const k = e.name.trim().toLowerCase();
    people[k] = Math.max(people[k] || 0, e.guests);
  });
  return Object.keys(people).reduce((n, k) => n + 1 + people[k], 0);
}

function esc_(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function notifyHost_(entry, entries) {
  const people = headcount_(entries);
  const plus = entry.guests ? ` (+${entry.guests})` : '';
  const subject = `🦃 ${entry.name}${plus} is bringing ${entry.dish}`;

  let rows = '';
  Object.keys(COURSES).forEach(id => {
    const list = entries.filter(e => e.course === id);
    rows += `<tr><td style="padding:6px 10px;font-weight:bold;vertical-align:top;white-space:nowrap">${COURSES[id]} (${list.length})</td><td style="padding:6px 10px">` +
      (list.length
        ? list.map(e => `${esc_(e.dish)} <span style="color:#7A5A72">· ${esc_(e.name)}${e.guests ? ' +' + e.guests : ''}</span>`).join('<br>')
        : '<span style="color:#B3263E">nobody yet</span>') +
      '</td></tr>';
  });

  const html =
    `<div style="font-family:Helvetica,Arial,sans-serif;color:#2B0F2E;max-width:560px">` +
    `<h2 style="margin:0 0 6px;color:#C9521F">New potluck sign-up</h2>` +
    `<p style="font-size:16px;margin:0 0 4px"><b>${esc_(entry.name)}</b>${plus} is bringing <b>${esc_(entry.dish)}</b> ` +
    `<span style="color:#7A5A72">(${COURSES[entry.course]}${entry.diet.length ? ', ' + esc_(entry.diet.join(', ')) : ''})</span></p>` +
    `<p style="margin:0 0 16px;color:#7A5A72">Running total: <b>${people} people</b> and <b>${entries.length} dishes</b> for ${PARTY_DATE}.</p>` +
    `<table style="border-collapse:collapse;background:#FFF4E2;border-radius:10px;width:100%">${rows}</table>` +
    (SITE_URL ? `<p style="margin-top:16px"><a href="${esc_(SITE_URL)}#table">Open the table</a></p>` : '') +
    `</div>`;

  MailApp.sendEmail({ to: HOST_EMAIL, subject, htmlBody: html, name: 'Friendsgiving RSVPs' });
}

/* ---------------- Claude ideas ---------------- */

function ideas_(b) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) return { ok: false, error: 'no api key' };

  // Light rate limit so a shared link can't run up your bill: 60 idea calls per 10 minutes.
  const cache = CacheService.getScriptCache();
  const used = Number(cache.get('ideas-count') || 0);
  if (used > 60) return { ok: false, error: 'busy' };
  cache.put('ideas-count', String(used + 1), 600);

  const taken = (Array.isArray(b.taken) ? b.taken : []).slice(0, 80)
    .map(t => `- ${clean_(t.dish, 80)} (${COURSES[t.course] || 'other'})`).join('\n') || '- nothing yet';
  const wanted = clean_(b.dish, 80);
  const course = COURSES[b.course] ? COURSES[b.course] : '';

  const prompt =
    `We're hosting a Friendsgiving potluck. A guest needs a dish idea.\n\n` +
    `Already claimed:\n${taken}\n\n` +
    (wanted ? `The guest wanted to bring: "${wanted}"${course ? ` (${course})` : ''}. It's taken or too similar to something above, so suggest alternatives in the same spirit.\n` :
              `The guest has no idea yet. Suggest what the table is missing most.\n`) +
    `\nGive 3 suggestions. Rules:\n` +
    `- Nothing that duplicates or closely overlaps a claimed dish.\n` +
    `- Favor courses that are thin (mains, sides, starters, bread, desserts, drinks).\n` +
    `- Realistic for a home cook to make or pick up and carry over.\n` +
    `- "dish" is a short name (max 5 words). "why" is a friendly reason, max 8 words.`;

  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: {
      'x-api-key': key,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    payload: JSON.stringify({
      model: 'claude-opus-5-5',
      max_tokens: 4000,
      fallbacks: 'default',
      output_config: {
        effort: 'low',
        format: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              ideas: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    dish: { type: 'string' },
                    course: { type: 'string', enum: Object.keys(COURSES) },
                    why: { type: 'string' },
                  },
                  required: ['dish', 'course', 'why'],
                  additionalProperties: false,
                },
              },
            },
            required: ['ideas'],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (res.getResponseCode() !== 200) {
    console.error('Claude API error', res.getResponseCode(), res.getContentText().slice(0, 500));
    return { ok: false, error: 'ideas unavailable' };
  }
  const msg = JSON.parse(res.getContentText());
  if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') return { ok: false, error: 'ideas unavailable' };
  const text = (msg.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) { return { ok: false, error: 'ideas unavailable' }; }
  const ideas = (parsed.ideas || []).slice(0, 4).map(i => ({
    dish: clean_(i.dish, 60), course: COURSES[i.course] ? i.course : 'side', why: clean_(i.why, 80),
  }));
  return { ok: true, ideas };
}

/* ---------------- Helpers ---------------- */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Run this once from the Apps Script editor (select "setup" and press Run).
 * It creates the sheet tab and sends you a test email, which also triggers
 * Google's permission prompt so the web app can save rows and send mail.
 */
function setup() {
  sheet_();
  MailApp.sendEmail(HOST_EMAIL, '🦃 Friendsgiving sign-ups are connected',
    'Your potluck sheet is ready. You will get an email like this every time someone claims a dish.');
}
