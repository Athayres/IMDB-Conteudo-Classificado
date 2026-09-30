// ───────────────────────── Metadados e Streams Corrigidos ─────────────────────────
async function meta(tipo, id, cfg) {
  const ehBloqueadoPeloID = id.startsWith('gpbloq:');
  const imdb = id.replace(/^gpbloq:/, '').split(':')[0];
  if (!/^tt\d+$/.test(imdb)) return null;

  let base = null;
  try {
    const r = await fetch(`https://v3-cinemeta.strem.io/meta/${tipo}/${imdb}.json`);
    if (r.ok) base = (await r.json()).meta;
  } catch { /* erro no cinemeta */ }

  if (!base) base = { id: imdb, type: tipo, name: imdb, description: '' };

  const { bloqueado, motivo, guia, br } = await analisarBloqueio(imdb, cfg);

  // Mudar o ID para 'gpbloq:' oculta o conteúdo para TODOS os outros addons (Torrentio, etc.)
  // O nome (base.name) permanece intacto na tela principal
  if (bloqueado || ehBloqueadoPeloID) {
    base.id = `gpbloq:${imdb}`;
    base.description = `⚠️ REPRODUÇÃO DESATIVADA PARA ${cfg.idade} ANOS.\nMotivo: ${motivo}\n\n${base.description || ''}`;
  } else {
    base.id = imdb;
  }

  // Detalhes da classificação na sinopse
  let descExtra = `\n\n• Classificação Indicativa: ${br ? (br === 'L' ? 'Livre' : br) : 'Não informada'}`;
  if (guia) {
    descExtra += `\n\n📊 Guia dos Pais (IMDb):`;
    for (const c of CATEGORIAS) {
      const val = guia[c.key];
      const txt = val != null ? `${COR[val]} ${NIVEIS[val]}` : '❓ Indisponível';
      descExtra += `\n• ${c.icone} ${c.rotulo}: ${txt}`;
    }
  }

  base.description = `${base.description || ''}${descExtra}`;
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
          title: `🛑 REPRODUÇÃO BLOQUEADA\n${motivo}`,
          externalUrl: `https://www.imdb.com/title/${imdb}/parentalguide/`, // Abre a página web do IMDb em vez de tocar o vídeo
        },
      ],
    };
  }
  return { streams: [] };
}