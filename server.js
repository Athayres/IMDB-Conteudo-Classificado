'use strict';
/**
 * Addon Stremio – Guia dos Pais (IMDb)
 *  - Painel de configuração visual em /configure.
 *  - Suporte completo para Filmes e Séries no TMDB.
 *  - Fallback de classificação (BR -> US).
 *  - Scraper resiliente para o IMDb.
 *
 * Requer Node 18+. Sem dependências externas.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 7000;
const TMDB_KEY = process.env.TMDB_KEY || '';
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

const CFG_PADRAO = { 
  max: { sexo: 3, violencia: 3, palavroes: 3, drogas: 3, susto: 3 }, 
  idade: 12,
  semInfo: true
};

// ───────────────────────── Cache em disco ─────────────────────────
let cache = { guias: {}, ids: {}, br: {} };
try { cache = Object.assign(cache, JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))); } catch { /* primeiro uso */ }
if (cache.v !== 3) { cache.guias = {}; cache.br = {}; cache.v = 3; }
let salvarTimer = null;
function salvar() {
  clearTimeout(salvarTimer);
  salvarTimer = setTimeout(() => fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)), 2000);
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
    if (typeof j.semInfo === 'boolean') cfg.semInfo = j.semInfo;
  } catch { /* usa padrão */ }
  return cfg;
}

function extrairIdadeNumerica(br) {
  if (!br) return null;
  const str = String(br).trim().toUpperCase();
  if (['L', 'FREE', 'G', 'TV-G', 'TV-Y', 'LIVRE', 'APPROVED'].includes(str)) return 0;
  if (['10', 'PG', 'TV-PG', 'TV-Y7'].includes(str)) return 10;
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
      headers: { 
        'User-Agent': UA, 
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' 
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) return null;
    const html = await r.text();
    const guia = {};
    let achou = false;
    const slugs = { sexo: 'nudity', violencia: 'violence', palavroes: 'profanity', drogas: 'alcohol', susto: 'frightening' };

    // Método 1: Match por Regex no HTML da página
    for (const [key, slug] of Object.entries(slugs)) {
      const reg = new RegExp(`(?:advisory-${slug}|category-${slug})[\\s\\S]{0,1000}?(None|Mild|Moderate|Severe)`, 'i');
      const m = html.match(reg);
      if (m && m[1]) {
        guia[key] = nivelDe(m[1]);
        achou = true;
      }
    }

    // Método 2: Parse de JSON embutido (__NEXT_DATA__) caso a estrutura do HTML mude
    if (!achou) {
      const matches = html.matchAll(/"category"\s*:\s*"([^"]+)"[\s\S]{0,200}?"severity"\s*:\s*"(None|Mild|Moderate|Severe)"/gi);
      for (const match of matches) {
        const cat = match[1].toLowerCase();
        const sev = match[2];
        for (const [key, slug] of Object.entries(slugs)) {
          if (cat.includes(slug)) {
            guia[key] = nivelDe(sev);
            achou = true;
          }
        }
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
    let cert = null;

    // Se for Filme
    if (f.movie_results && f.movie_results.length > 0) {
      const movieId = f.movie_results[0].id;
      const d = await fetch(`https://api.themoviedb.org/3/movie/${movieId}/release_dates?api_key=${TMDB_KEY}`).then(r => r.json());
      const res = d.results || [];
      const br = res.find((x) => x.iso_3166_1 === 'BR');
      const us = res.find((x) => x.iso_3166_1 === 'US');
      
      const relBr = br && br.release_dates.find((x) => x.certification);
      const relUs = us && us.release_dates.find((x) => x.certification);
      cert = relBr ? relBr.certification : (relUs ? relUs.certification : null);
    } 
    // Se for Série de TV
    else if (f.tv_results && f.tv_results.length > 0) {
      const tvId = f.tv_results[0].id;
      const d = await fetch(`https://api.themoviedb.org/3/tv/${tvId}/content_ratings?api_key=${TMDB_KEY}`).then(r => r.json());
      const res = d.results || [];
      const br = res.find((x) => x.iso_3166_1 === 'BR');
      const us = res.find((x) => x.iso_3166_1 === 'US');
      cert = br ? br.rating : (us ? us.rating : null);
    }

    cache.br[imdbId] = cert;
    salvar();
    return cert;
  } catch { return null; }
}

// ───────────────────────── Lógica de Bloqueio ─────────────────────────
async function analisarBloqueio(imdb, cfg) {
  const [guia, br] = await Promise.all([
    naFilaIMDb(() => buscarGuia(imdb)).catch(() => null),
    classificacaoBR(imdb).catch(() => null),
  ]);

  let bloqueado = false;
  let motivo = '';

  const idadeNum = extrairIdadeNumerica(br);

  // 1. Checa Idade Indicativa Oficial
  if (cfg.idade < 18 && idadeNum !== null && idadeNum > cfg.idade) {
    bloqueado = true;
    motivo = `Classificação (${br === 'L' ? 'Livre' : br}) acima de ${cfg.idade} anos.`;
  }

  // 2. Checa Níveis das Categorias do IMDb
  if (!bloqueado && guia) {
    for (const c of CATEGORIAS) {
      if (guia[c.key] != null && guia[c.key] > cfg.max[c.key]) {
        bloqueado = true;
        motivo = `${c.rotulo} (${NIVEIS[guia[c.key]]}) acima do permitido.`;
        break;
      }
    }
  }

  // 3. Regra Rigorosa de 12 Anos
  if (!bloqueado && cfg.idade <= 12 && guia) {
    for (const c of CATEGORIAS) {
      if (guia[c.key] === 3) {
        bloqueado = true;
        motivo = `Conteúdo Grave em ${c.rotulo} (Impróprio para 12 anos).`;
        break;
      }
    }
  }

  // 4. Bloqueio caso realmente não exista dados no IMDb nem no TMDB
  if (!bloqueado && cfg.semInfo && cfg.idade < 18 && (idadeNum === null && !guia)) {
    bloqueado = true;
    motivo = 'Classificação indicativa não encontrada / não informada.';
  }

  return { bloqueado, motivo, guia, br };
}

// ───────────────────────── Metadados e Streams ─────────────────────────
async function meta(tipo, id, cfg) {
  const ehBloqueadoPeloID = id.startsWith('gpbloq:');
  const imdb = id.replace(/^gpbloq:/, '').split(':')[0];
  if (!/^tt\d+$/.test(imdb)) return null;

  let base = null;
  try {
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/${tipo}/${imdb}.json`);
    if (r.ok) base = (await r.json()).meta;
  } catch { /* erro no cinemeta */ }

  if (!base) base = { id, type: tipo, name: imdb, description: '' };

  const { bloqueado, motivo, guia, br } = await analisarBloqueio(imdb, cfg);

  base.id = (bloqueado || ehBloqueadoPeloID) ? `gpbloq:${imdb}` : imdb;

  let descExtra = `\n\n• Classificação: ${br ? (br === 'L' ? 'Livre' : br) : 'Não informada'}`;
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
    version: '2.3.0',
    name: 'Guia dos Pais (Bloqueio Total)',
    logo: LOGO,
    description: 'Bloqueio parental com trava de prefixo para desativar addons externos.',
    resources: ['meta', 'stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt', 'gpbloq:'],
    catalogs: [],
    behaviorHints: { configurable: true },
  };
}

// ───────────────────────── Interface do Painel de Configuração ─────────────────────────
function paginaConfig(cfg) {
  const linhas = CATEGORIAS.map((c) => `
      <label>${c.icone} ${c.rotulo}
        <select data-cat="${c.key}">
          ${NIVEIS.map((n, i) => `<option value="${i}">${i === 3 ? 'Permitir até Grave' : 'Permitir até: ' + n}</option>`).join('')}
        </select>
      </label>`).join('');

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Guia dos Pais – Configurar</title>
<link rel="icon" href="${LOGO}">
<style>
  :root{color-scheme:light dark;--bg:#f6f5fb;--fg:#1b1b26;--card:#fff;--bd:#d9d7e6;--ac:#6b4cff;--sec:#8b5cf6}
  @media(prefers-color-scheme:dark){:root{--bg:#14141c;--fg:#ececf5;--card:#1e1e2a;--bd:#34344a}}
  body{margin:0;font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg)}
  main{max-width:520px;margin:0 auto;padding:24px 16px}
  h1{font-size:1.4rem;margin:0 0 4px;display:flex;align-items:center;gap:10px} h1 img{width:44px;height:44px;border-radius:10px} p{opacity:.75;margin:0 0 20px}
  .card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:16px;display:grid;gap:14px}
  label{display:grid;gap:6px;font-weight:600}
  .chk-label{display:flex;align-items:center;gap:10px;cursor:pointer}
  select,input[type="text"]{font:inherit;padding:10px;border-radius:10px;border:1px solid var(--bd);background:transparent;color:inherit}
  input[type="checkbox"]{width:18px;height:18px;accent-color:var(--ac)}
  .btn-group{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  @media(max-width:480px){.btn-group{grid-template-columns:1fr}}
  a.btn{font:inherit;font-weight:700;border:0;border-radius:10px;padding:12px;background:var(--ac);color:#fff;text-align:center;text-decoration:none;cursor:pointer}
  a.btn-web{background:var(--sec)}
  button.sec{font:inherit;font-weight:600;background:transparent;color:var(--fg);border:1px solid var(--bd);border-radius:10px;padding:10px;cursor:pointer}
  button.reset{font:inherit;font-weight:600;background:#22c55e;color:#fff;border:0;border-radius:10px;padding:10px;cursor:pointer}
</style></head><body><main>
  <h1><img src="${LOGO}" alt="">Guia dos Pais (IMDb)</h1>
  <p>Configure a trava e a classificação indicativa para o Stremio.</p>
  <div class="card">
    <button class="reset" id="btnLiberarTudo" type="button">🔓 Liberar Tudo (Sem limites)</button>
    <label>🇧🇷 Idade Máxima Permitida
      <select id="idade">
        <option value="18">18 Anos (Sem restrições)</option>
        <option value="16">16 Anos (Bloqueia +18)</option>
        <option value="14">14 Anos (Bloqueia +16 e +18)</option>
        <option value="12">12 Anos (Bloqueia +14, +16, +18 e Conteúdo Grave)</option>
        <option value="10">10 Anos (Bloqueia +12 em diante)</option>
        <option value="0">Livre (Apenas conteúdo Livre)</option>
      </select>
    </label>
    <label class="chk-label">
      <input type="checkbox" id="semInfo">
      🔒 Bloquear vídeos sem classificação informada
    </label>
    ${linhas}
    <div class="btn-group">
      <a class="btn" id="instalarApp" href="#">Instalar no App</a>
      <a class="btn btn-web" id="instalarWeb" target="_blank" href="#">Instalar no Web</a>
    </div>
    <input id="url" type="text" readonly>
    <button class="sec" id="copiar" type="button">Copiar link do addon</button>
  </div>
</main>
<script>
  var CFG = ${JSON.stringify(cfg)};
  var sels = document.querySelectorAll('select[data-cat]');
  sels.forEach(function(s){ s.value = CFG.max[s.dataset.cat]; s.onchange = atualizar; });
  
  var id = document.getElementById('idade'); 
  if (id) { id.value = CFG.idade; id.onchange = atualizar; }
  
  var chk = document.getElementById('semInfo');
  if (chk) { chk.checked = CFG.semInfo !== false; chk.onchange = atualizar; }
  
  document.getElementById('btnLiberarTudo').onclick = function() {
    if (id) id.value = '18';
    if (chk) chk.checked = false;
    sels.forEach(function(s){ s.value = '3'; });
    atualizar();
  };

  function atualizar(){
    var c = { 
      max: {}, 
      idade: id ? Number(id.value) : CFG.idade,
      semInfo: chk ? chk.checked : true
    };
    sels.forEach(function(s){ c.max[s.dataset.cat] = Number(s.value); });
    var b64 = btoa(JSON.stringify(c)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
    
    var proto = location.protocol;
    var host = location.host;
    var manifestUrl = proto + '//' + host + '/' + b64 + '/manifest.json';
    var webUrl = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl);
    var appUrl = 'stremio://' + host + '/' + b64 + '/manifest.json';
    
    document.getElementById('url').value = manifestUrl;
    document.getElementById('instalarApp').href = appUrl;
    document.getElementById('instalarWeb').href = webUrl;
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
    'Access-Control-Allow-Headers': '*',
  });
  res.end(JSON.stringify(obj));
}

const RESERVADOS = new Set(['configure', 'manifest.json', 'stream', 'meta', 'health']);

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const partes = url.pathname.split('/').filter(Boolean);

    if (!partes.length) { 
      res.writeHead(302, { Location: '/configure' }); 
      return res.end(); 
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
  console.log(`Guia dos Pais ativo em http://localhost:${PORT}/configure`);
});