'use strict';
/**
 * Addon Stremio – Guia dos Pais (IMDb) em PT-BR
 *  - Mostra o guia do IMDb e classificação indicativa do Brasil (via TMDB).
 *  - Mostra a classificação indicativa (só o número, sem ícone) como 1º item da linha de Gêneros ("Idade: 16").
 *  - Se a idade for "Sem limite", funciona apenas como aviso (não bloqueia nada).
 *  - Se for definida uma idade (ex: 16), bloqueia títulos dessa idade para cima (16 e 18 anos).
 *
 * Requer Node 18+. Sem dependências.
 *   TMDB_KEY=sua_chave node server.js   →   http://localhost:7000/configure
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 7000;
const TMDB_KEY = process.env.TMDB_KEY || '';
const DATA_DIR = process.env.DATA_DIR || __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignora */ }
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
const GUIA_TTL = 30 * 24 * 3600 * 1000; // 30 dias
const BLOQ = 'gpbloq:'; // prefixo de id para títulos bloqueados
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

// Padrão: Sem limite (18 = Apenas aviso, sem bloqueios)
const CFG_PADRAO = { max: { sexo: 3, violencia: 3, palavroes: 3, drogas: 3, susto: 3 }, idade: 18 };

// ───────────────────────── Cache em disco ─────────────────────────
let cache = { guias: {}, ids: {}, br: {} };
try { cache = Object.assign(cache, JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))); } catch { /* primeiro uso */ }
if (cache.v !== 2) { cache.guias = {}; cache.v = 2; }
let salvarTimer = null;
function salvar() {
  clearTimeout(salvarTimer);
  salvarTimer = setTimeout(() => fs.writeFile(CACHE_FILE, JSON.stringify(cache), () => {}), 2000);
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

// ───────────────────────── IMDb: Guia dos Pais ─────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const NULO_TTL = 12 * 3600 * 1000;

async function baixarPaginaIMDb(imdbId) {
  try {
    const r = await fetch(`https://www.imdb.com/title/${imdbId}/parentalguide/`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(12000),
    });
    return { status: r.status, html: await r.text() };
  } catch (e) { return { status: 0, html: '', erro: String((e && e.message) || e) }; }
}

const GQL_QUERY = 'query($id: ID!){ title(id:$id){ parentsGuide{ categories{ category{ id text } severity{ id text votedFor } totalSeverityVotes } } } }';
async function baixarGraphQL(imdbId) {
  try {
    const r = await fetch('https://api.graphql.imdb.com/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA, Origin: 'https://www.imdb.com', Referer: 'https://www.imdb.com/' },
      body: JSON.stringify({ query: GQL_QUERY, variables: { id: imdbId } }),
      signal: AbortSignal.timeout(12000),
    });
    const texto = await r.text();
    let json = null;
    try { json = JSON.parse(texto); } catch { /* não é JSON */ }
    return { status: r.status, json, texto };
  } catch (e) { return { status: 0, json: null, texto: '', erro: String((e && e.message) || e) }; }
}

function nivelDoItem(el) {
  const s = el.severity ?? el.severitySummary;
  if (s != null) {
    const candidatos = typeof s === 'object' ? [s.text, s.id, s.value, s.label] : [s];
    for (const c of candidatos) {
      const n = nivelDe(c);
      if (n !== null) return n;
    }
  }
  const votos = [0, 0, 0, 0];
  let tem = false;
  if (el.votes && typeof el.votes === 'object') {
    [['noneVotes', 0], ['mildVotes', 1], ['moderateVotes', 2], ['severeVotes', 3]].forEach(([k, i]) => {
      const n = Number(el.votes[k]);
      if (n > 0) { votos[i] += n; tem = true; }
    });
  }
  const lista = el.severityBreakdown || el.severityVotes;
  if (Array.isArray(lista)) {
    for (const v of lista) {
      const i = [v.voteType, v.id, v.text].map(nivelDe).find((x) => x !== null) ?? null;
      const n = Number(v.votedFor ?? v.votes ?? v.count);
      if (i !== null && n > 0) { votos[i] += n; tem = true; }
    }
  }
  if (!tem) return null;
  const total = votos.reduce((a, b) => a + b, 0);
  let acum = 0;
  for (let i = 0; i < 4; i++) { acum += votos[i]; if (acum >= total / 2) return i; }
  return null;
}

function coletarCategorias(no, saida = [], prof = 0) {
  if (!no || typeof no !== 'object' || prof > 16) return saida;
  if (Array.isArray(no) && no.some((e) => e && typeof e === 'object' && e.category && (typeof e.category === 'string' || e.category.id || e.category.text))) saida.push(no);
  for (const v of Object.values(no)) coletarCategorias(v, saida, prof + 1);
  return saida;
}

function guiaDeJson(dados) {
  const guia = {};
  let achou = false;
  for (const arr of coletarCategorias(dados)) {
    for (const el of arr) {
      if (!el || !el.category) continue;
      const cat = el.category;
      const id = String(typeof cat === 'string' ? cat : cat.id || '').toUpperCase();
      const txt = typeof cat === 'string' ? cat : String(cat.text || '');
      const alvo = CATEGORIAS.find((x) => x.ids.includes(id) || x.texto.test(txt) || x.texto.test(id));
      if (!alvo) continue;
      const nivel = nivelDoItem(el);
      if (guia[alvo.key] == null) guia[alvo.key] = nivel;
      if (nivel !== null) achou = true;
    }
  }
  return achou ? guia : null;
}

function guiaDeHtml(html) {
  const slugs = { sexo: 'nudity', violencia: 'violence', palavroes: 'profanity', drogas: 'alcohol', susto: 'frightening' };
  const guia = {};
  let achou = false;
  for (const [key, slug] of Object.entries(slugs)) {
    const i = html.search(new RegExp(`advisory-${slug}`, 'i'));
    if (i < 0) continue;
    const trecho = html.slice(i, i + 1500).replace(/<[^>]+>/g, ' ');
    const m = trecho.match(/\b(None|Mild|Moderate|Severe)\b/);
    if (m) { guia[key] = nivelDe(m[1]); achou = true; }
  }
  return achou ? guia : null;
}

function extrairGuia(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try { const g = guiaDeJson(JSON.parse(m[1])); if (g) return g; } catch { /* tenta o HTML */ }
  }
  return guiaDeHtml(html);
}

async function consultarIMDb(imdbId) {
  const dbg = { imdbId };
  const gq = await baixarGraphQL(imdbId);
  dbg.graphql = { status: gq.status, erro: gq.erro, inicio: (gq.texto || '').slice(0, 300) };
  if (gq.json) {
    const g = guiaDeJson(gq.json);
    if (g) return { guia: g, dbg };
    if (gq.json.data && gq.json.data.title && !gq.json.errors) return { guia: null, dbg };
  }
  const p = await baixarPaginaIMDb(imdbId);
  dbg.pagina = {
    status: p.status, erro: p.erro, tamanho: p.html.length,
    temNextData: p.html.includes('__NEXT_DATA__'),
    temAdvisory: /advisory-nudity/i.test(p.html),
    titulo: (p.html.match(/<title>([^<]*)<\/title>/i) || [])[1] || null,
    inicio: p.html.slice(0, 300),
  };
  const g = p.html ? extrairGuia(p.html) : null;
  return { guia: g, falhou: !g && p.status !== 200, dbg };
}

async function buscarGuia(imdbId) {
  const c = cache.guias[imdbId];
  if (c && Date.now() - c.t < (c.g ? GUIA_TTL : NULO_TTL)) return c.g;
  const r = await consultarIMDb(imdbId);
  if (r.falhou) return undefined;
  cache.guias[imdbId] = { t: Date.now(), g: r.guia };
  salvar();
  return r.guia;
}

function idadeDeBR(br) {
  if (!br) return null;
  if (br === 'L') return 0;
  const n = parseInt(br, 10);
  return Number.isFinite(n) ? n : null;
}

// ───────────────────────── Lógica de Avaliação ─────────────────────────
function avaliar(guia, br, cfg) {
  if (cfg.idade === 18) {
    return { bloqueado: false, motivos: [] };
  }

  const motivos = [];

  const idade = idadeDeBR(br);
  if (idade !== null && idade >= cfg.idade) {
    const nomeIdade = idade === 0 ? 'Livre' : idade + ' anos';
    motivos.push(`classificação indicativa ${nomeIdade} (seu limite: bloquear ${cfg.idade} anos ou mais)`);
  }

  if (guia && typeof guia === 'object') {
    for (const c of CATEGORIAS) {
      const n = guia[c.key];
      if (n != null && n > cfg.max[c.key]) {
        motivos.push(`${c.rotulo}: ${NIVEIS[n]}`);
      }
    }
  }

  return { bloqueado: motivos.length > 0, motivos };
}

function textoGuia(guia, br) {
  let linhas;
  if (guia === undefined) linhas = ['ℹ️ Guia dos Pais do IMDb indisponível no momento'];
  else if (guia === null) linhas = ['ℹ️ Este título não possui Guia dos Pais no IMDb (sem votos)'];
  else linhas = CATEGORIAS.map((c) => `${c.icone} ${c.rotulo}: ${guia[c.key] != null ? `${COR[guia[c.key]]}${NIVEIS[guia[c.key]]}` : '❔ sem votos'}`);
  if (br) linhas.unshift(`Classificação indicativa: ${br === 'L' ? 'Livre' : br + ' anos'}`);
  return linhas.join('\n');
}

function blocoGuia(guia, br, cfg, mostrarIdade = true) {
  const av = avaliar(guia, br, cfg);
  let topo = '✅ Liberado pelo Guia dos Pais\n';
  if (av.bloqueado) {
    topo = '⛔ BLOQUEADO pelo Guia dos Pais\n';
  } else if (cfg.idade === 18) {
    topo = 'ℹ️ GUIA DOS PAIS (Modo Informativo)\n';
  }
  return { av, texto: `👪 ${topo}${textoGuia(guia, mostrarIdade ? br : null)}` };
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

const findCache = new Map();
async function acharTMDB(imdbId) {
  if (findCache.has(imdbId)) return findCache.get(imdbId);
  const f = await tmdb(`/find/${imdbId}`, { external_source: 'imdb_id' });
  findCache.set(imdbId, f);
  return f;
}

async function resumoPtBR(imdbId) {
  if (!TMDB_KEY) return null;
  try {
    const f = await acharTMDB(imdbId);
    const it = (f.movie_results || [])[0] || (f.tv_results || [])[0];
    return it && it.overview ? it.overview : null;
  } catch { return null; }
}

async function classificacaoBR(imdbId) {
  if (!TMDB_KEY) return null;
  if (cache.br[imdbId] !== undefined) return cache.br[imdbId];
  try {
    const f = await acharTMDB(imdbId);
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

// ───────────────────────── Streams ─────────────────────────
async function streams(id, cfg) {
  const bloqueadoPeloId = id.startsWith(BLOQ);
  const imdb = (bloqueadoPeloId ? id.slice(BLOQ.length) : id).split(':')[0];
  if (!/^tt\d+$/.test(imdb)) return [];
  // Modo informativo: nunca mostra nada junto aos vídeos (o guia fica só abaixo do resumo)
  if (!bloqueadoPeloId && cfg.idade === 18) return [];
  const url = `https://www.imdb.com/title/${imdb}/parentalguide/`;
  const [guia, br] = await Promise.all([naFilaIMDb(() => buscarGuia(imdb)), classificacaoBR(imdb)]);
  const { av, texto } = blocoGuia(guia, br, cfg);
  // Só aparece na lista de vídeos quando há motivo: título bloqueado
  if (!bloqueadoPeloId && !av.bloqueado) return [];
  return [{
    name: '⛔ Guia dos Pais',
    description: texto + '\n\n(Toque para ver detalhes no IMDb)',
    externalUrl: url,
  }];
}

// ───────────────────────── Metadados ─────────────────────────
async function meta(tipo, id, cfg) {
  const imdb = id.split(':')[0];
  if (!/^tt\d+$/.test(imdb)) return null;
  let base = null;
  try {
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/${tipo}/${imdb}.json`, { signal: AbortSignal.timeout(8000) });
    if (r.ok) base = (await r.json()).meta || null;
  } catch { /* sem Cinemeta */ }
  if (!base) return null;

  const [guia, br, resumo] = await Promise.all([naFilaIMDb(() => buscarGuia(imdb)), classificacaoBR(imdb), resumoPtBR(imdb)]);

  // Idade (ex.: "Idade: 16") como 1º item da linha de Gêneros: sem ícone, na mesma linha dos gêneros.
  // O Stremio Web monta os gêneros a partir de "links"; clientes antigos leem "genres".
  if (br) {
    const idadeTag = `Idade: ${br === 'L' ? 'Livre' : br}`;
    base.genres = [idadeTag, ...(base.genres || [])];
    if (Array.isArray(base.links)) {
      const links = base.links.slice();
      const i = links.findIndex((l) => l && l.category === 'Genres');
      if (i >= 0) {
        links.splice(i, 0, { name: idadeTag, category: 'Genres', url: `https://www.imdb.com/title/${imdb}/parentalguide/` });
        base.links = links;
      }
    }
  }
  // A idade também vai no bloco abaixo do resumo (clientes que não desenham os gêneros só mostram esse bloco)
  const { av, texto } = blocoGuia(guia, br, cfg);

  if (av.bloqueado) {
    if (tipo === 'movie') base.behaviorHints = Object.assign({}, base.behaviorHints, { defaultVideoId: BLOQ + imdb });
    if (Array.isArray(base.videos)) base.videos = base.videos.map((v) => Object.assign({}, v, { id: BLOQ + v.id }));
  }

  // Em séries, ao escolher um episódio o Stremio Web troca o resumo da série pelo "overview" do episódio:
  // o guia também é acrescentado lá, senão ele some justamente na tela dos vídeos.
  if (Array.isArray(base.videos)) {
    base.videos = base.videos.map((v) => Object.assign({}, v, { overview: v.overview ? `${v.overview}\n\n${texto}` : texto }));
  }

  const original = resumo || base.description || '';
  base.description = original ? `${original}\n\n${texto}` : texto;
  return base;
}

// ───────────────────────── Manifest ─────────────────────────
function manifest(configuravel = true) {
  return {
    id: 'community.guiadospais.ptbr',
    version: '1.4.7',
    name: 'Guia dos Pais (IMDb)',
    logo: LOGO,
    description: 'Controle parental e guia informativo IMDb: exibe os níveis do guia, classificação indicativa nos gêneros e bloqueia títulos.',
    resources: ['meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', BLOQ],
    catalogs: [],
    behaviorHints: { configurable: configuravel },
  };
}

// ───────────────────────── Página de Configuração ─────────────────────────
function paginaConfig(cfg) {
  const linhas = CATEGORIAS.map((c) => `
      <label>${c.icone} ${c.rotulo}
        <select data-cat="${c.key}">
          ${NIVEIS.map((n, i) => `<option value="${i}">${i === 3 ? 'Permitir até Grave' : 'Permitir até: ' + n}</option>`).join('')}
        </select>
      </label>`).join('');

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Guia dos Pais (IMDb) – Configurar</title>
<link rel="icon" href="${LOGO}">
<style>
  :root{color-scheme:light dark;--bg:#f6f5fb;--fg:#1b1b26;--card:#fff;--bd:#d9d7e6;--ac:#6b4cff}
  @media(prefers-color-scheme:dark){:root{--bg:#14141c;--fg:#ececf5;--card:#1e1e2a;--bd:#34344a}}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--fg)}
  main{max-width:520px;margin:0 auto;padding:24px 16px}
  h1{font-size:1.4rem;margin:0 0 4px;display:flex;align-items:center;gap:10px} h1 img{width:44px;height:44px;border-radius:10px} p{opacity:.75;margin:0 0 20px}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:16px;display:grid;gap:14px}
  label{display:grid;gap:6px;font-weight:600}
  select,input{font:inherit;padding:10px;border-radius:10px;border:1px solid var(--bd);background:transparent;color:inherit}
  button,a.btn{font:inherit;font-weight:700;border:0;border-radius:10px;padding:12px;background:var(--ac);color:#fff;text-align:center;text-decoration:none;cursor:pointer}
  button.sec{background:transparent;color:var(--fg);border:1px solid var(--bd)}
  small{opacity:.7}
</style></head><body><main>
  <h1><img src="${LOGO}" alt="">Guia dos Pais (IMDb)</h1>
  <p>Escolha o modo de funcionamento e os limites desejados.</p>
  <div class="card">
    <label>🇧🇷 Modos de Bloqueio por Idade
      <select id="idade">
        <option value="18">Sem limite (Apenas aviso, não bloqueia)</option>
        <option value="16">Bloquear 16 anos ou mais (16 e 18 anos)</option>
        <option value="14">Bloquear 14 anos ou mais (14, 16 e 18 anos)</option>
        <option value="12">Bloquear 12 anos ou mais (12, 14, 16 e 18 anos)</option>
        <option value="10">Bloquear 10 anos ou mais (10, 12, 14, 16 e 18 anos)</option>
        <option value="0">Bloquear tudo exceto Livre</option>
      </select>
    </label>
    ${linhas}
    <a class="btn" id="instalar" href="#">Instalar no Stremio</a>
    <input id="url" readonly>
    <button class="sec" id="copiar" type="button">Copiar link do addon</button>
    <small>No modo "Sem limite", o addon apenas insere o resumo do Guia dos Pais sem impedir a reprodução de nada.</small>
  </div>
</main>
<script>
  var CFG = ${JSON.stringify(cfg)};
  var sels = document.querySelectorAll('select[data-cat]');
  sels.forEach(function(s){ s.value = CFG.max[s.dataset.cat]; s.onchange = atualizar; });
  var id = document.getElementById('idade'); if (id) { id.value = CFG.idade; id.onchange = atualizar; }
  function atualizar(){
    var c = { max:{}, idade: id ? Number(id.value) : CFG.idade };
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

const RESERVADOS = new Set(['configure', 'manifest.json', 'stream', 'meta', 'health', 'debug']);

http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' }); return res.end(); }
    const { pathname } = new URL(req.url, 'http://x');
    const partes = pathname.split('/').filter(Boolean);
    if (!partes.length) { res.writeHead(302, { Location: '/configure' }); return res.end(); }
    if (partes[0] === 'health') return json(res, { ok: true });
    if (partes[0] === 'debug') {
      const id = (partes[1] || '').replace(/\.json$/, '');
      if (!/^tt\d+$/.test(id)) return json(res, { erro: 'use /debug/tt0111161' }, 0, 400);
      const r = await consultarIMDb(id);
      return json(res, { guia: r.guia, diagnostico: r.dbg });
    }

    const cfgB64 = RESERVADOS.has(partes[0]) ? '' : partes.shift();
    const cfg = lerConfig(cfgB64);
    const dec = (s) => decodeURIComponent((s || '').replace(/\.json$/, ''));

    if (partes[0] === 'configure') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(paginaConfig(cfg));
    }
    if (partes[0] === 'manifest.json') return json(res, manifest());

    if (partes[0] === 'meta') {
      const m = await meta(dec(partes[1]), dec(partes[2]), cfg);
      return m ? json(res, { meta: m }, 300) : json(res, { erro: 'sem metadados' }, 0, 404);
    }

    if (partes[0] === 'stream') {
      const lista = await streams(dec(partes[2]), cfg);
      return json(res, { streams: lista }, 300);
    }

    json(res, { erro: 'não encontrado' }, 0, 404);
  } catch (e) {
    console.error(e);
    json(res, { metas: [], streams: [] }, 0, 500);
  }
}).listen(PORT, () => {
  console.log(`Guia dos Pais (IMDb) a rodar em http://localhost:${PORT}/configure`);
  if (!TMDB_KEY) console.log('⚠ Defina TMDB_KEY (opcional) para ter a classificação indicativa do Brasil.');
});