'use strict';
/**
 * Addon Stremio – Guia dos Pais (IMDb) com Trava de Prefixo
 *  - Usa o prefixo 'gpbloq:' para desativar outros addons (Torrentio, SuperFlix) em filmes bloqueados.
 *  - Oferece catálogos filtrados para navegação segura.
 *  - Regra rigorosa para 12 anos (bloqueia +18 e conteúdo Grave do IMDb).
 *
 * Requer Node 18+. Sem dependências.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 7000;
const TMDB_KEY = process.env.TMDB_KEY || '';
const MDBLIST_KEY = process.env.MDBLIST_KEY || '';
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignora */ }
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const GUIA_TTL = 30 * 24 * 3600 * 1000;
const LOGO = 'https://raw.githubusercontent.com/Athayres/IMDB-Conteudo-Classificado/refs/heads/main/logo_family.jpg';

const NIVEIS = ['Nenhum', 'Leve', 'Moderado', 'Grave'];
const COR = ['⬜', '🟩', '🟨', '🟥'];
const CATEGORIAS = [
  { key: 'sexo', rotulo: 'Sexo e nudez', icone: '🔞', ids: ['NUDITY'], texto: /nudity|sex/i },
  { key: 'violencia', rotulo: 'Violência e sangue', icone: '🩸', ids: ['VIOLENCE'], texto: /violence|gore/i },
  { key: 'palavroes', rotulo: 'Palavrões', icone: '🤬', ids: ['PROFANITY'], texto: /profanity/i },
  { key: 'drogas', rotulo: 'Álcool, drogas e fumo', icone: '🍺', ids: ['ALCOHOL'], texto: /alcohol|drugs|smoking/i },
  { key: 'susto', rotulo: 'Cenas intensas e assustadoras', icone: '😱', ids: ['FRIGHTENING'], texto: /frightening|intense/i },
];

const CFG_PADRAO = { max: { sexo: 3, violencia: 3, palavroes: 3, drogas: 3, susto: 3 }, idade: 12 };

// ───────────────────────── Cache em disco ─────────────────────────
let cache = { guias: {}, ids: {}, br: {}, mdb: {} };
try { cache = Object.assign(cache, JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))); } catch { /* primeiro uso */ }
if (cache.v !== 2) { cache.guias = {}; cache.v = 2; }
let salvarTimer = null;
function salvar() {
  clearTimeout(salvarTimer);
  salvarTimer = setTimeout(() => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache), () => {}), 2000);
}

// ───────────────────────── Utilidades ─────────────────────────
function limitar(n) {
  let ativos = 0;
  const fila = [];
  const prox = () => {
    if (ativos >= n || !fila.length) return;
    ativos++;
    const { fn, res, rej } = fila.shift();
    fn().then(res, rej).finally(() => { ativos--; prox(); });
  };
  return (fn) => new Promise((res, rej) => { fila.push({ fn, res, rej }); prox(); });
}
const naFilaIMDb = limitar(3);

function nivelDe(v) {
  switch (String(v || '').toUpperCase().replace(/VOTES$/, '')) {
    case 'NONE': return 0;
    case 'MILD': return 1;
    case 'MODERATE': return 2;
    case 'SEVERE': return 3;
    default: return null;
  }
}

function lerConfig(b64) {
  const cfg = JSON.parse(JSON.stringify(CFG_PADRAO));
  if (!b64) return cfg;
  try {
    const j = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    for (const c of CATEGORIAS) {
      const v = Number(j.max && j.max[c.key]);
      if (Number.isInteger(v) && v >= 0 && v <= 3) cfg.max[c.key] = v;
    }
    const idade = Number(j.idade);
    if ([0, 10, 12, 14, 16, 18].includes(idade)) cfg.idade = idade;
  } catch { /* usa padrão */ }
  return cfg;
}

function extrairIdadeNumerica(br) {
  if (!br) return null;
  const str = String(br).trim().toUpperCase();
  if (['L', 'FREE', 'G', 'TV-G', 'TV-Y', 'LIVRE'].includes(str)) return 0;
  if (['10', 'PG', 'TV-PG'].includes(str)) return 10;
  if (str === '12') return 12;
  if (['14', 'PG-13', 'TV-14'].includes(str)) return 14;
  if (['16', 'R'].includes(str)) return 16;
  if (['18', 'NC-17', 'TV-MA', 'X', '+18', '18+'].includes(str)) return 18;
  const m = str.match(/\d+/);
  return m ? parseInt(m[0], 10) : null;
}

// ───────────────────────── IMDb e Fontes de Dados ─────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

async function buscarGuia(imdbId) {
  const c = cache.guias[imdbId];
  if (c && Date.now() - c.t < GUIA_TTL) return c.g;
  try {
    const r = await fetch(`https://www.imdb.com/title/${imdbId}/parentalguide/`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(10000),
    });
    const html = await r.text();
    const guia = {};
    let achou = false;
    const slugs = { sexo: 'nudity', violencia: 'violence', palavroes: 'profanity', drogas: 'alcohol', susto: 'frightening' };
    for (const [key, slug] of Object.entries(slugs)) {
      const idx = html.search(new RegExp(`advisory-${slug}`, 'i'));
      if (idx >= 0) {
        const trecho = html.slice(idx, idx + 1500).replace(/<[^>]+>/g, ' ');
        const m = trecho.match(/\b(None|Mild|Moderate|Severe)\b/i);
        if (m) { guia[key] = nivelDe(m[1]); achou = true; }
      }
    }
    const res = achou ? guia : null;
    cache.guias[imdbId] = { t: Date.now(), g: res };
    salvar();
    return res;
  } catch {
    return null;
  }
}

async function classificacaoBR(imdbId) {
  if (!TMDB_KEY) return null;
  if (cache.br[imdbId] !== undefined) return cache.br[imdbId];
  try {
    const f = await fetch(`https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id`).then(r => r.json());
    let br = null;
    if (f.movie_results && f.movie_results[0]) {
      const d = await fetch(`https://api.themoviedb.org/3/movie/${f.movie_results[0].id}/release_dates?api_key=${TMDB_KEY}`).then(r => r.json());
      const p = (d.results || []).find((x) => x.iso_3166_1 === 'BR');
      const rel = p && p.release_dates.find((x) => x.certification);
      br = rel ? rel.certification : null;
    }
    cache.br[imdbId] = br;
    salvar();
    return br;
  } catch { return null; }
}

// ───────────────────────── Lógica Central de Bloqueio ─────────────────────────
async function analisarBloqueio(imdb, cfg) {
  const [guia, br] = await Promise.all([
    naFilaIMDb(() => buscarGuia(imdb)).catch(() => null),
    classificacaoBR(imdb).catch(() => null),
  ]);

  let bloqueado = false;
  let motivo = '';

  const idadeNum = extrairIdadeNumerica(br);

  if (cfg.idade < 18 && idadeNum !== null && idadeNum > cfg.idade) {
    bloqueado = true;
    motivo = `Classificação (${br === 'L' ? 'Livre' : br + ' anos'}) acima de ${cfg.idade} anos.`;
  }

  if (!bloqueado && guia) {
    for (const c of CATEGORIAS) {
      if (guia[c.key] != null && guia[c.key] > cfg.max[c.key]) {
        bloqueado = true;
        motivo = `${c.rotulo} (${NIVEIS[guia[c.key]]}) acima do permitido.`;
        break;
      }
    }
  }

  if (!bloqueado && cfg.idade <= 12 && guia) {
    for (const c of CATEGORIAS) {
      if (guia[c.key] === 3) {
        bloqueado = true;
        motivo = `Conteúdo Grave em ${c.rotulo} (Impróprio para 12 anos).`;
        break;
      }
    }
  }

  return { bloqueado, motivo, guia, br };
}

// ───────────────────────── Rotas de Metadados e Streams ─────────────────────────
async function meta(tipo, id, cfg) {
  const ehBloqueadoPeloID = id.startsWith('gpbloq:');
  const imdb = id.replace(/^gpbloq:/, '').split(':')[0];
  if (!/^tt\d+$/.test(imdb)) return null;

  let base = null;
  try {
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/${tipo}/${imdb}.json`);
    if (r.ok) base = (await r.json()).meta;
  } catch { /* falha cinemeta */ }

  if (!base) base = { id, type: tipo, name: imdb, description: '' };

  const { bloqueado, motivo, guia, br } = await analisarBloqueio(imdb, cfg);

  // Mantém o ID alterado se estiver bloqueado
  base.id = (bloqueado || ehBloqueadoPeloID) ? `gpbloq:${imdb}` : imdb;

  let descExtra = `\n\n• Classificação: ${br ? (br === 'L' ? 'Livre' : br + ' anos') : 'Não informada'}`;
  if (guia) {
    for (const c of CATEGORIAS) {
      if (guia[c.key] != null) descExtra += `\n• ${c.icone} ${c.rotulo}: ${COR[guia[c.key]]} ${NIVEIS[guia[c.key]]}`;
    }
  }

  if (bloqueado || ehBloqueadoPeloID) {
    base.name = `🛑 [BLOQUEADO] ${base.name}`;
    base.description = `⚠️ CONTEÚDO BLOQUEADO PARA ${cfg.idade} ANOS.\nMotivo: ${motivo}${descExtra}`;
  } else {
    base.description = `${base.description || ''}${descExtra}`;
  }

  return base;
}

async function stream(tipo, id, cfg) {
  const ehBloqueadoPeloID = id.startsWith('gpbloq:');
  const imdb = id.replace(/^gpbloq:/, '').split(':')[0];
  
  const { bloqueado, motivo } = await analisarBloqueio(imdb, cfg);

  if (bloqueado || ehBloqueadoPeloID) {
    return {
      streams: [
        {
          name: 'Guia dos Pais',
          title: `🛑 REPRODUÇÃO BLOQUEADA (${cfg.idade} ANOS)\n${motivo}`,
          externalUrl: `https://www.imdb.com/title/${imdb}/parentalguide/`,
        },
      ],
    };
  }
  return { streams: [] };
}

// ───────────────────────── Manifest ─────────────────────────
function manifest() {
  return {
    id: 'community.guiadospais.ptbr',
    version: '2.1.0',
    name: 'Guia dos Pais (Bloqueio Total)',
    logo: LOGO,
    description: 'Aplica a trava gpbloq: para desativar addons externos em filmes +18.',
    resources: ['meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'gpbloq:'],
    catalogs: [],
    behaviorHints: { configurable: true },
  };
}

// ───────────────────────── Servidor HTTP ─────────────────────────
function json(res, obj, maxAge = 0, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
  });
  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const partes = url.pathname.split('/').filter(Boolean);
    if (!partes.length) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<h1>Addon Guia dos Pais Ativo</h1><p>Configure no Stremio usando a URL do manifest.</p>`);
    }

    const cfgB64 = ['manifest.json', 'stream', 'meta'].includes(partes[0]) ? '' : partes.shift();
    const cfg = lerConfig(cfgB64);
    const dec = (s) => decodeURIComponent((s || '').replace(/\.json$/, ''));

    if (partes[0] === 'manifest.json') return json(res, manifest());

    if (partes[0] === 'meta') {
      const m = await meta(dec(partes[1]), dec(partes[2]), cfg);
      return json(res, { meta: m }, 300);
    }

    if (partes[0] === 'stream') {
      const s = await stream(dec(partes[1]), dec(partes[2]), cfg);
      return json(res, s, 300);
    }

    json(res, { erro: 'não encontrado' }, 0, 404);
  } catch (e) {
    console.error(e);
    json(res, { streams: [] }, 0, 500);
  }
}).listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});