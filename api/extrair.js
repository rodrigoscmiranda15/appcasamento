// api/extrair.js — Vercel Serverless Function
// A chave nunca sai do servidor. Painel da Vercel:
//   Settings → Environment Variables → GEMINI_API_KEY

const MODELO = "gemini-3.6-flash";   // 3.7 e 3.8 Flash também servem: mesma interface, só trocar a string
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODELO}:generateContent`;

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

  try {
    const r = await fetch(URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": process.env.GEMINI_API_KEY
      },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          // temperature/top_p/top_k foram descontinuados em julho/2026: não enviar
          responseMimeType: "application/json"   // dispensa recortar o JSON do texto
        }
      })
    });

    const out = await r.json();

    if (!r.ok) {
      console.error("gemini", r.status, JSON.stringify(out).slice(0, 500));
      const msg = r.status === 429
        ? "limite diário de leituras atingido; tente amanhã ou preencha à mão"
        : (out && out.error && out.error.message) || "erro na API do Gemini";
      return res.status(r.status).json({ error: msg });
    }

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
