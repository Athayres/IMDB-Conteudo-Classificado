'use strict';
/**
 * Addon Stremio – Guia dos Pais (IMDb) em PT-BR
 *  - Catálogos (filmes/séries populares do TMDB em pt-BR) filtrados pelos SEUS limites
 *  - Ao abrir qualquer título, mostra uma "stream" informativa com o guia completo
 *    + classificação indicativa do Brasil (via TMDB) e veredito "dentro/acima do limite"
 *
 * Requer Node 18+. Sem dependências.
 *   TMDB_KEY=sua_chave node server.js   →   http://localhost:7000/configure
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 7000;
const TMDB_KEY = process.env.TMDB_KEY || '';
const DATA_DIR = process.env.DATA_DIR || __dirname; // aponte para um volume persistente ao hospedar
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignora */ }
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const GUIA_TTL = 30 * 24 * 3600 * 1000; // 30 dias
const PAGE = 20;
const MAX_PAGINAS = 4;
const ORCAMENTO_MS = 8000; // tempo máx. montando um catálogo
const IMG = 'https://image.tmdb.org/t/p/';

const NIVEIS = ['Nenhum', 'Leve', 'Moderado', 'Grave'];
const CATEGORIAS = [
  { key: 'sexo', rotulo: 'Sexo e nudez', icone: '🔞', ids: ['NUDITY'], texto: /nudity|sex/i },
  { key: 'violencia', rotulo: 'Violência e sangue', icone: '🩸', ids: ['VIOLENCE'], texto: /violence|gore/i },
  { key: 'palavroes', rotulo: 'Palavrões', icone: '🤬', ids: ['PROFANITY'], texto: /profanity/i },
  { key: 'drogas', rotulo: 'Álcool, drogas e fumo', icone: '🍺', ids: ['ALCOHOL'], texto: /alcohol|drugs|smoking/i },
  { key: 'susto', rotulo: 'Cenas intensas e assustadoras', icone: '😱', ids: ['FRIGHTENING'], texto: /frightening|intense/i },
];
const CFG_PADRAO = { max: { sexo: 1, violencia: 2, palavroes: 2, drogas: 2, susto: 2 }, semGuia: 'ocultar' };

// ───────────────────────── cache em disco ─────────────────────────
let cache = { guias: {}, ids: {}, br: {} };
try { cache = Object.assign(cache, JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))); } catch { /* primeiro uso */ }
let salvarTimer = null;
function salvar() {
  clearTimeout(salvarTimer);
  salvarTimer = setTimeout(() => fs.writeFile(CACHE_FILE, JSON.stringify(cache), () => {}), 2000);
}

// ───────────────────────── utilidades ─────────────────────────
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
  switch (String(v || '').toUpperCase()) {
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
    if (j.semGuia === 'mostrar') cfg.semGuia = 'mostrar';
  } catch { /* usa padrão */ }
  return cfg;
}

// ───────────────────────── IMDb: Guia dos Pais ─────────────────────────
async function baixarPaginaIMDb(imdbId) {
  try {
    const r = await fetch(`https://www.imdb.com/title/${imdbId}/parentalguide/`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        Accept: 'text/html',
      },
      signal: AbortSignal.timeout(10000),
    });
    return r.ok ? await r.text() : null;
  } catch { return null; }
}

function acharCategorias(no, prof = 0) {
  if (!no || typeof no !== 'object' || prof > 14) return null;
  if (Array.isArray(no.categories) && no.categories.some((c) => c && c.category && c.category.id)) return no.categories;
  for (const v of Object.values(no)) {
    const r = acharCategorias(v, prof + 1);
    if (r) return r;
  }
  return null;
}

function extrairGuia(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let dados;
  try { dados = JSON.parse(m[1]); } catch { return null; }
  const cats = acharCategorias(dados);
  if (!cats) return null;
  const guia = {};
  let achou = false;
  for (const c of cats) {
    const id = String(c.category.id || '').toUpperCase();
    const txt = String(c.category.text || '');
    const alvo = CATEGORIAS.find((x) => x.ids.includes(id) || x.texto.test(txt));
    if (!alvo) continue;
    const sev = c.severity || c.severitySummary || {};
    const nivel = nivelDe(sev.id ?? sev.text ?? sev.value);
    guia[alvo.key] = nivel; // null = sem votos suficientes
    if (nivel !== null) achou = true;
  }
  return achou ? guia : null;
}

async function buscarGuia(imdbId) {
  const c = cache.guias[imdbId];
  if (c && Date.now() - c.t < GUIA_TTL) return c.g;
  const html = await baixarPaginaIMDb(imdbId);
  if (!html) return null; // falha de rede: não grava no cache
  const g = extrairGuia(html);
  cache.guias[imdbId] = { t: Date.now(), g };
  salvar();
  return g;
}

function passa(guia, cfg) {
  if (!guia) return cfg.semGuia === 'mostrar';
  return CATEGORIAS.every((c) => guia[c.key] == null || guia[c.key] <= cfg.max[c.key]);
}

function textoGuia(guia, br) {
  const linhas = CATEGORIAS.map((c) => `${c.icone} ${c.rotulo}: ${guia && guia[c.key] != null ? NIVEIS[guia[c.key]] : 'sem votos'}`);
  if (br) linhas.unshift(`🇧🇷 Classificação indicativa: ${br === 'L' ? 'Livre' : br + ' anos'}`);
  return linhas.join('\n');
}

// ───────────────────────── TMDB ─────────────────────────
async function tmdb(caminho, params = {}) {
  const u = new URL('https://api.themoviedb.org/3' + caminho);
  u.searchParams.set('api_key', TMDB_KEY);
  u.searchParams.set('language', 'pt-BR');
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('TMDB ' + r.status);
  return r.json();
}

async function imdbDe(tipo, tmdbId) {
  const k = `${tipo}:${tmdbId}`;
  if (cache.ids[k] !== undefined) return cache.ids[k];
  const d = await tmdb(`/${tipo === 'movie' ? 'movie' : 'tv'}/${tmdbId}/external_ids`);
  cache.ids[k] = d.imdb_id || null;
  salvar();
  return cache.ids[k];
}

async function classificacaoBR(imdbId) {
  if (!TMDB_KEY) return null;
  if (cache.br[imdbId] !== undefined) return cache.br[imdbId];
  try {
    const f = await tmdb(`/find/${imdbId}`, { external_source: 'imdb_id' });
    let br = null;
    if (f.movie_results && f.movie_results[0]) {
      const d = await tmdb(`/movie/${f.movie_results[0].id}/release_dates`);
      const p = d.results.find((x) => x.iso_3166_1 === 'BR');
      const rel = p && p.release_dates.find((x) => x.certification);
      br = rel ? rel.certification : null;
    } else if (f.tv_results && f.tv_results[0]) {
      const d = await tmdb(`/tv/${f.tv_results[0].id}/content_ratings`);
      const p = d.results.find((x) => x.iso_3166_1 === 'BR');
      br = p ? p.rating || null : null;
    }
    cache.br[imdbId] = br;
    salvar();
    return br;
  } catch { return null; }
}

// ───────────────────────── Catálogo ─────────────────────────
async function catalogo(tipo, cfg, skip, busca) {
  if (!TMDB_KEY) return [];
  const t = tipo === 'movie' ? 'movie' : 'tv';
  const alvo = skip + PAGE;
  const limite = Date.now() + ORCAMENTO_MS;
  const aprovados = [];
  const vistos = new Set();

  for (let pagina = 1; pagina <= MAX_PAGINAS && aprovados.length < alvo && Date.now() < limite; pagina++) {
    const d = busca
      ? await tmdb(`/search/${t}`, { query: busca, page: pagina })
      : await tmdb(`/${t}/popular`, { page: pagina });
    if (!d.results || !d.results.length) break;

    const lote = await Promise.all(d.results.map(async (it) => {
      try {
        const imdb = await imdbDe(tipo, it.id);
        if (!imdb || vistos.has(imdb)) return null;
        const jaTem = cache.guias[imdb] && Date.now() - cache.guias[imdb].t < GUIA_TTL;
        if (!jaTem && Date.now() > limite) return null; // sem tempo: fica pro próximo carregamento
        const guia = await naFilaIMDb(() => buscarGuia(imdb));
        if (!passa(guia, cfg)) return null;
        const ano = (it.release_date || it.first_air_date || '').slice(0, 4);
        return {
          id: imdb,
          type: tipo,
          name: it.title || it.name,
          poster: it.poster_path ? IMG + 'w342' + it.poster_path : undefined,
          background: it.backdrop_path ? IMG + 'w780' + it.backdrop_path : undefined,
          releaseInfo: ano || undefined,
          description: `${textoGuia(guia)}\n\n${it.overview || ''}`.trim(),
        };
      } catch { return null; }
    }));

    for (const m of lote) {
      if (m && !vistos.has(m.id)) { vistos.add(m.id); aprovados.push(m); }
    }
    if (pagina >= d.total_pages) break;
  }
  return aprovados.slice(skip, alvo);
}

// ───────────────────────── Streams (painel do Guia dos Pais) ─────────────────────────
async function streams(id, cfg) {
  const imdb = id.split(':')[0];
  if (!/^tt\d+$/.test(imdb)) return [];
  const url = `https://www.imdb.com/title/${imdb}/parentalguide/`;
  const [guia, br] = await Promise.all([naFilaIMDb(() => buscarGuia(imdb)), classificacaoBR(imdb)]);

  if (!guia && !br) {
    return [{ name: 'Guia dos Pais', description: 'Guia dos Pais indisponível para este título.\nToque para abrir no IMDb.', externalUrl: url }];
  }
  let veredito = '';
  if (guia) {
    const acima = CATEGORIAS.filter((c) => guia[c.key] != null && guia[c.key] > cfg.max[c.key]);
    veredito = acima.length
      ? `⛔ Acima do seu limite: ${acima.map((c) => c.rotulo).join(', ')}\n`
      : '✅ Dentro dos seus limites\n';
  }
  return [{ name: 'Guia dos Pais', description: veredito + textoGuia(guia, br) + '\n(toque para ver detalhes no IMDb)', externalUrl: url }];
}

// ───────────────────────── Manifest ─────────────────────────
function manifest(configuravel = true) {
  return {
    id: 'community.guiadospais.ptbr',
    version: '1.0.0',
    name: 'Guia dos Pais (IMDb)',
    description: 'Controle parental por categoria usando o Guia dos Pais do IMDb: filtra catálogos e mostra o guia completo (com a classificação indicativa do Brasil) em cada título.',
    resources: ['catalog', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [
      { type: 'movie', id: 'gp-filmes', name: 'Filmes populares – Guia dos Pais', extra: [{ name: 'skip' }, { name: 'search' }] },
      { type: 'series', id: 'gp-series', name: 'Séries populares – Guia dos Pais', extra: [{ name: 'skip' }, { name: 'search' }] },
    ],
    behaviorHints: { configurable: configuravel },
  };
}

// ───────────────────────── Página de configuração (PT-BR) ─────────────────────────
function paginaConfig(cfg) {
  const linhas = CATEGORIAS.map((c) => `
      <label>${c.icone} ${c.rotulo}
        <select data-cat="${c.key}">
          ${NIVEIS.map((n, i) => `<option value="${i}">${i === 3 ? 'Sem limite (até Grave)' : 'Permitir até: ' + n}</option>`).join('')}
        </select>
      </label>`).join('');
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Guia dos Pais (IMDb) – Configurar</title>
<style>
  :root{color-scheme:light dark;--bg:#f6f5fb;--fg:#1b1b26;--card:#fff;--bd:#d9d7e6;--ac:#6b4cff}
  @media(prefers-color-scheme:dark){:root{--bg:#14141c;--fg:#ececf5;--card:#1e1e2a;--bd:#34344a}}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
  main{max-width:520px;margin:0 auto;padding:24px 16px}
  h1{font-size:1.4rem;margin:0 0 4px} p{opacity:.75;margin:0 0 20px}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:16px;display:grid;gap:14px}
  label{display:grid;gap:6px;font-weight:600}
  select,input{font:inherit;padding:10px;border-radius:10px;border:1px solid var(--bd);background:transparent;color:inherit}
  button,a.btn{font:inherit;font-weight:700;border:0;border-radius:10px;padding:12px;background:var(--ac);color:#fff;text-align:center;text-decoration:none;cursor:pointer}
  button.sec{background:transparent;color:var(--fg);border:1px solid var(--bd)}
  small{opacity:.7}
</style></head><body><main>
  <h1>👪 Guia dos Pais (IMDb)</h1>
  <p>Escolha o nível máximo aceito em cada categoria. Títulos acima do limite somem dos catálogos e ficam marcados no painel do título.</p>
  <div class="card">${linhas}
    <label>Títulos sem Guia dos Pais no IMDb
      <select id="semGuia"><option value="ocultar">Ocultar dos catálogos</option><option value="mostrar">Mostrar mesmo assim</option></select>
    </label>
    <a class="btn" id="instalar" href="#">Instalar no Stremio</a>
    <input id="url" readonly>
    <button class="sec" id="copiar" type="button">Copiar link do addon</button>
    <small>Os níveis vêm de votos de usuários do IMDb (Nenhum, Leve, Moderado, Grave).</small>
  </div>
</main>
<script>
  var CFG = ${JSON.stringify(cfg)};
  var sels = document.querySelectorAll('select[data-cat]');
  sels.forEach(function(s){ s.value = CFG.max[s.dataset.cat]; s.onchange = atualizar; });
  var sg = document.getElementById('semGuia'); sg.value = CFG.semGuia; sg.onchange = atualizar;
  function atualizar(){
    var c = { max:{}, semGuia: sg.value };
    sels.forEach(function(s){ c.max[s.dataset.cat] = Number(s.value); });
    var b64 = btoa(JSON.stringify(c)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
    var url = location.protocol + '//' + location.host + '/' + b64 + '/manifest.json';
    document.getElementById('url').value = url;
    document.getElementById('instalar').href = 'stremio://' + location.host + '/' + b64 + '/manifest.json';
  }
  document.getElementById('copiar').onclick = function(){
    var i = document.getElementById('url'); i.select();
    (navigator.clipboard ? navigator.clipboard.writeText(i.value) : Promise.resolve(document.execCommand('copy'))).then(function(){ document.getElementById('copiar').textContent = 'Copiado!'; });
  };
  atualizar();
</script></body></html>`;
}

// ───────────────────────── Servidor HTTP ─────────────────────────
function json(res, obj, maxAge = 0, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-cache',
  });
  res.end(JSON.stringify(obj));
}

const RESERVADOS = new Set(['configure', 'manifest.json', 'catalog', 'stream', 'health']);

http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
    const { pathname } = new URL(req.url, 'http://x');
    const partes = pathname.split('/').filter(Boolean);
    if (!partes.length) { res.writeHead(302, { Location: '/configure' }); return res.end(); }
    if (partes[0] === 'health') return json(res, { ok: true });

    const cfgB64 = RESERVADOS.has(partes[0]) ? '' : partes.shift();
    const cfg = lerConfig(cfgB64);
    const dec = (s) => decodeURIComponent((s || '').replace(/\.json$/, ''));

    if (partes[0] === 'configure') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(paginaConfig(cfg));
    }
    if (partes[0] === 'manifest.json') return json(res, manifest());

    if (partes[0] === 'catalog') {
      const tipo = dec(partes[1]);
      const extra = new URLSearchParams((partes[3] || '').replace(/\.json$/, ''));
      const skip = Math.max(0, parseInt(extra.get('skip') || '0', 10) || 0);
      const busca = extra.get('search') || '';
      const metas = ['movie', 'series'].includes(tipo) ? await catalogo(tipo, cfg, skip, busca) : [];
      return json(res, { metas }, 600);
    }

    if (partes[0] === 'stream') {
      const lista = await streams(dec(partes[2]), cfg);
      return json(res, { streams: lista }, 3600);
    }

    json(res, { erro: 'não encontrado' }, 0, 404);
  } catch (e) {
    console.error(e);
    json(res, { metas: [], streams: [] }, 0, 500);
  }
}).listen(PORT, () => {
  console.log(`Guia dos Pais (IMDb) rodando em http://localhost:${PORT}/configure`);
  if (!TMDB_KEY) console.log('⚠ Defina TMDB_KEY para habilitar os catálogos e a classificação indicativa do Brasil.');
});
