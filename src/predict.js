const fs = require('fs');
const path = require('path');

const BASE = 'https://api.thestatsapi.com/api';
const LEAGUES = [
  'Premier League','La Liga','Serie A','Bundesliga','Ligue 1',
  'Eredivisie','Primeira Liga','Pro League','Süper Lig','Bundesliga Austria'
];

const argv = Object.fromEntries(
  process.argv.slice(2).map((v, i, a) => v.startsWith('--') ? [v.slice(2), a[i + 1]] : null).filter(Boolean)
);

const leagueArg = argv.league || 'all';
const date = argv.date || new Date().toISOString().slice(0, 10);
const outDir = path.join('predictions', date);
fs.mkdirSync(outDir, { recursive: true });

if (!process.env.THETATSAPI_KEY) throw new Error('Falta THESTATSAPI_KEY');

async function api(pathname) {
  const r = await fetch(BASE + pathname, {
    headers: { Authorization: `Bearer ${process.env.THETATSAPI_KEY}` }
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${pathname}: ${text}`);
  return JSON.parse(text);
}

const factorial = n => n <= 1 ? 1 : n * factorial(n - 1);
const poisson = (l, k) => Math.exp(-l) * Math.pow(l, k) / factorial(k);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const pct = n => `${(n * 100).toFixed(1)}%`;

function poissonMatrix(xh, xa) {
  let ph = 0, pd = 0, pa = 0, btts = 0, over = 0;
  for (let h = 0; h <= 8; h++) {
    for (let a = 0; a <= 8; a++) {
      const p = poisson(xh, h) * poisson(xa, a);
      if (h > a) ph += p; else if (h === a) pd += p; else pa += p;
      if (h > 0 && a > 0) btts += p;
      if (h + a > 2.5) over += p;
    }
  }
  return { ph, pd, pa, btts, over };
}

function normalize3(h, d, a) {
  const s = h + d + a || 1;
  return { home: h / s, draw: d / s, away: a / s };
}

function marketFromOdds(odds) {
  const books = odds?.data?.bookmakers || [];
  const mo = books.map(b => b.markets?.match_odds).find(Boolean);
  if (!mo) return null;
  const h = parseFloat(mo.home?.last_seen), d = parseFloat(mo.draw?.last_seen), a = parseFloat(mo.away?.last_seen);
  if (![h, d, a].every(Number.isFinite)) return null;
  return normalize3(1 / h, 1 / d, 1 / a);
}

function slug(s) {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

async function resolveCompetition(name) {
  const res = await api(`/football/competitions?search=${encodeURIComponent(name)}&per_page=100`);
  const list = res.data || [];
  const exact = list.find(c => c.name.toLowerCase() === name.toLowerCase());
  return exact || list.find(c => c.odds_available) || list[0];
}

const statsCache = new Map();
async function getTeamStats(teamId, seasonId) {
  const key = `${teamId}:${seasonId}`;
  if (!statsCache.has(key)) {
    statsCache.set(key, api(`/football/teams/${teamId}/stats?season_id=${seasonId}`)
      .then(r => r.data)
      .catch(() => null));
  }
  return statsCache.get(key);
}

function expectedGoals(hs, as) {
  const avg = 1.35;
  if (!hs || !as || !hs.matches_played || !as.matches_played) return { xh: 1.42, xa: 1.10 };

  const hAttack = hs.goals_for / hs.matches_played / avg;
  const hDefense = hs.goals_against / hs.matches_played / avg;
  const aAttack = as.goals_for / as.matches_played / avg;
  const aDefense = as.goals_against / as.matches_played / avg;

  return {
    xh: clamp(avg * hAttack * aDefense * 1.12, 0.25, 3.25),
    xa: clamp(avg * aAttack * hDefense * 0.92, 0.20, 3.00)
  };
}

async function predictMatch(m, seasonId) {
  const [hs, as] = await Promise.all([
    getTeamStats(m.home_team.id, seasonId),
    getTeamStats(m.away_team.id, seasonId)
  ]);

  let { xh, xa } = expectedGoals(hs, as);

  let market = null;
  let oddsAvailable = false;
  if (m.odds_available) {
    try {
      const odds = await api(`/football/matches/${m.id}/odds`);
      market = marketFromOdds(odds);
      oddsAvailable = Boolean(market);
    } catch {}
  }

  const model = poissonMatrix(xh, xa);
  let pHome = model.ph, pDraw = model.pd, pAway = model.pa;

  if (market) {
    pHome = 0.65 * model.ph + 0.35 * market.home;
    pDraw = 0.65 * model.pd + 0.35 * market.draw;
    pAway = 0.65 * model.pa + 0.35 * market.away;
    const n = normalize3(pHome, pDraw, pAway);
    pHome = n.home; pDraw = n.draw; pAway = n.away;
  }

  const pick = pHome >= pAway && pHome >= pDraw ? m.home_team.name
    : pAway >= pDraw ? m.away_team.name : 'Empate';

  return {
    id: m.id,
    utc_date: m.utc_date,
    status: m.status,
    home: m.home_team.name,
    away: m.away_team.name,
    pick,
    p_home: +pHome.toFixed(4),
    p_draw: +pDraw.toFixed(4),
    p_away: +pAway.toFixed(4),
    btts: +model.btts.toFixed(4),
    over_25: +model.over.toFixed(4),
    xg_home: +xh.toFixed(3),
    xg_away: +xa.toFixed(3),
    market_blended: oddsAvailable
  };
}

async function predictLeague(name) {
  console.log(`\n=== ${name} · ${date} ===`);
  const comp = await resolveCompetition(name);
  if (!comp) return { league: name, error: 'Competition not found', matches: [] };

  const detail = await api(`/football/competitions/${comp.id}`);
  let seasonId = detail.data?.current_season_id;

  if (!seasonId) {
    const seasons = (await api(`/football/competitions/${comp.id}/seasons`)).data || [];
    seasonId = seasons.find(s => s.is_current)?.id || seasons[0]?.id;
  }

  const q = `/football/matches?competition_id=${comp.id}&season_id=${seasonId}&date_from=${date}&date_to=${date}&status=scheduled&per_page=100`;
  const matches = (await api(q)).data || [];

  const rows = [];
  for (const m of matches.slice(0, 40)) {
    try {
      rows.push(await predictMatch(m, seasonId));
      await new Promise(r => setTimeout(r, 120));
    } catch (e) {
      rows.push({ id: m.id, home: m.home_team?.name, away: m.away_team?.name, error: String(e.message) });
    }
  }

  const file = path.join(outDir, `${slug(comp.name)}.json`);
  fs.writeFileSync(file, JSON.stringify({ date, competition: comp.name, competition_id: comp.id, season_id: seasonId, generated_at: new Date().toISOString(), matches: rows }, null, 2));

  const summaryPath = path.join(outDir, 'summary.md');
  const lines = rows.map(r => r.error
    ? `- ${r.home ?? '?'} vs ${r.away ?? '?'}: ERROR ${r.error}`
    : `- ${r.home} vs ${r.away}: **${r.pick}** · 1X2 ${pct(r.p_home)}/${pct(r.p_draw)}/${pct(r.p_away)} · BTTS ${pct(r.btts)} · +2.5 ${pct(r.over_25)}`
  );
  fs.appendFileSync(summaryPath, `\n## ${comp.name}\n${lines.join('\n')}\n`);

  console.log(`${comp.name}: ${rows.length} partidos -> ${file}`);
}

(async () => {
  const selected = leagueArg === 'all' ? LEAGUES : [leagueArg];
  for (const l of selected) await predictLeague(l);
})();
