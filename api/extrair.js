// api/extrair.js — Vercel Serverless Function
// A chave nunca sai do servidor. Painel da Vercel:
//   Settings → Environment Variables → GEMINI_API_KEY

// Em ordem de preferência. Se o primeiro estiver sobrecarregado, cai para o próximo.
const MODELOS = ["gemini-3.6-flash", "gemini-3.5-flash-lite"];
const url = m => `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

const espera = ms => new Promise(r => setTimeout(r, ms));
const TRANSITORIO = new Set([429, 500, 502, 503, 504]);

// GitHub Pages e Vercel são domínios diferentes: sem CORS o navegador bloqueia.
const ORIGENS = [
  "https://SEU-USUARIO.github.io",
  "http://localhost:3000"
];

function cors(req, res) {
  const o = req.headers.origin;
  if (ORIGENS.includes(o)) res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

export default async function handler(req, res) {
  cors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "use POST" });

  const { partes, prompt } = req.body || {};
  if (!Array.isArray(partes) || !partes.length || !prompt) {
    return res.status(400).json({ error: "faltam partes ou prompt" });
  }

  // ~15 MB de arquivo. base64 é cerca de 4/3 do binário.
  const peso = partes.reduce((a, p) => a + (p.data?.length || p.texto?.length || 0), 0);
  if (peso > 20000000) return res.status(413).json({ error: "conteúdo grande demais" });

  // tradução para o formato do Gemini
  const parts = partes.map(p =>
    p.tipo === "texto"
      ? { text: p.texto }
      : { inline_data: { mime_type: p.mime, data: p.data } }
  );
  parts.push({ text: prompt });

  const corpo = JSON.stringify({
    contents: [{ parts }],
    generationConfig: {
      // temperature/top_p/top_k foram descontinuados em julho/2026: não enviar
      responseMimeType: "application/json"   // dispensa recortar o JSON do texto
    }
  });

  // Duas tentativas por modelo, com espera crescente, depois troca de modelo.
  // Sobrecarga do Gemini é comum e quase sempre passa em segundos.
  async function tentar() {
    let ultimo = null;
    for (const modelo of MODELOS) {
      for (let i = 0; i < 2; i++) {
        const r = await fetch(url(modelo), {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY
          },
          body: corpo
        });
        const out = await r.json();
        if (r.ok) return { r, out, modelo };

        ultimo = { r, out, modelo };
        console.error("gemini", modelo, r.status, JSON.stringify(out).slice(0, 300));
        if (!TRANSITORIO.has(r.status)) return ultimo;   // erro real: não insistir
        if (i === 0) await espera(1200);                 // 1ª falha: espera e repete
      }
    }
    return ultimo;
  }

  try {
    const { r, out, modelo } = await tentar();

    if (!r.ok) {
      const msg = r.status === 429
        ? "limite de leituras atingido; tente daqui a pouco ou preencha à mão"
        : TRANSITORIO.has(r.status)
          ? "o serviço de leitura está sobrecarregado agora. Tente de novo em alguns segundos"
          : (out && out.error && out.error.message) || "erro na API do Gemini";
      return res.status(r.status).json({ error: msg });
    }
    if (modelo !== MODELOS[0]) console.warn("usou o modelo reserva:", modelo);

    const cand = out && out.candidates && out.candidates[0];
    const texto = (cand && cand.content && cand.content.parts || [])
      .map(p => p.text || "").join("");
    if (!texto) {
      return res.status(502).json({ error: `sem conteúdo (${(cand && cand.finishReason) || "vazio"})` });
    }

    let json;
    try { json = JSON.parse(texto); }
    catch {
      const a = texto.indexOf("{"), z = texto.lastIndexOf("}");
      if (a < 0 || z < 0) return res.status(502).json({ error: "resposta não é JSON" });
      json = JSON.parse(texto.slice(a, z + 1));
    }
    return res.status(200).json(json);

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "falha ao processar o documento" });
  }
}
