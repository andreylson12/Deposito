// server.js – Railway + Postgres + PIX + Produtos/Pedidos + Telegram (+ debug) + Push Web (opcional)
const express = require("express");
const path = require("path");
const cors = require("cors");
const { QrCodePix } = require("qrcode-pix");

// web-push é opcional
let webpush = null;
try { webpush = require("web-push"); } catch { /* opcional */ }

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------- Basic Auth --------------------------------- */
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "senha123";
const ADMIN_REALM = "Adega Admin";

function basicAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const [type, b64] = h.split(" ");
  if (type === "Basic" && b64) {
    const [u, p] = Buffer.from(b64, "base64").toString().split(":");
    if (u === ADMIN_USER && p === ADMIN_PASS) return next();
  }
  res.set("WWW-Authenticate", `Basic realm="${ADMIN_REALM}", charset="UTF-8"`);
  res.status(401).send("Autenticação requerida");
}
const adminOnly = [basicAuth];

/* -------------------------------- Middlewares -------------------------------- */
app.use(express.json({ limit: "5mb" }));
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

/* ------------------------------ Arquivos estáticos --------------------------- */
app.use(
  express.static(path.join(__dirname, "public"), {
    index: false, // impede servir index.html automaticamente
  })
);

/* -------------------------- Rotas de páginas (UI) ---------------------------- */
app.get(["/", "/index", "/index.html"], basicAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get(["/delivery", "/delivery.html"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "delivery.html"));
});
app.get("/health", (_req, res) => res.json({ ok: true }));

/* -------------------------------- Config PIX -------------------------------- */
const chavePix = "55160826000100";   // CNPJ SEM máscara
const nomeLoja = "RS LUBRIFICANTES"; // máx 25
const cidade   = "SAMBAIBA";         // máx 15

/* ----------------------------- Push Web (opcional) --------------------------- */
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT     || "mailto:suporte@exemplo.com";
if (webpush && VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
} else if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.warn("[web-push] sem VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY — recurso de push web ficará inativo.");
}

/* ----------------------- Telegram (com logs e debug) ------------------------- */
const _fetch = (...args) =>
  (globalThis.fetch ? globalThis.fetch(...args) : import("node-fetch").then(m => m.default(...args)));

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID  || "";

async function sendTelegramMessage(text) {
  try {
    if (!TG_TOKEN || !TG_CHAT) {
      console.warn("[telegram] faltando variáveis. TG_TOKEN?", !!TG_TOKEN, "TG_CHAT?", !!TG_CHAT);
      return;
    }
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const r = await _fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const body = await r.text();
    if (!r.ok) console.warn("[telegram] falhou:", r.status, body);
    else console.log("[telegram] ok:", body);
  } catch (e) {
    console.warn("[telegram] erro:", e?.message || e);
  }
}

// Endpoints de debug do Telegram
app.get("/debug/telegram", async (req, res) => {
  try {
    const text = String(req.query.text || "Teste do servidor ✅");
    if (!TG_TOKEN || !TG_CHAT) {
      return res.status(400).json({ ok: false, error: "Faltam TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID" });
    }
    const r = await _fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
    const bodyText = await r.text();
    try { return res.status(r.status).json(JSON.parse(bodyText)); }
    catch { return res.status(r.status).type("text/plain").send(bodyText); }
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});
app.get("/debug/telegram/getMe", async (_req, res) => {
  if (!TG_TOKEN) return res.status(400).json({ error: "Sem TELEGRAM_BOT_TOKEN" });
  const r = await _fetch(`https://api.telegram.org/bot${TG_TOKEN}/getMe`);
  res.status(r.status).json(await r.json());
});
app.get("/debug/telegram/getChat", async (_req, res) => {
  if (!TG_TOKEN || !TG_CHAT) return res.status(400).json({ error: "Sem TOKEN/CHAT_ID" });
  const r = await _fetch(`https://api.telegram.org/bot${TG_TOKEN}/getChat?chat_id=${encodeURIComponent(TG_CHAT)}`);
  res.status(r.status).json(await r.json());
});

/* ------------------------------- Banco (Postgres) ---------------------------- */
const { Pool } = require("pg");

function normalizeDbUrl(u) {
  if (!u) return u;
  if (!/\?.*sslmode=/.test(u)) u += (u.includes("?") ? "&" : "?") + "sslmode=require";
  return u;
}
const pool = new Pool({
  connectionString: normalizeDbUrl(process.env.DATABASE_URL),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000,
  max: 10,
});

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      preco NUMERIC NOT NULL DEFAULT 0,
      estoque INTEGER NOT NULL DEFAULT 0,
      imagem TEXT,
      created_at TIMESTAMP DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS pedidos (
      id TEXT PRIMARY KEY,
      cliente JSONB,
      itens   JSONB,
      total   NUMERIC NOT NULL DEFAULT 0,
      status  TEXT NOT NULL DEFAULT 'Pendente',
      pix     JSONB,
      created_at TIMESTAMP DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS push_subs (
      endpoint TEXT PRIMARY KEY,
      sub JSONB NOT NULL
    );
  `);
}
ensureSchema().catch(e => console.error("ensureSchema:", e));

// Debug DB helpers
app.get("/debug/db-ensure", async (_req, res) => {
  try { await ensureSchema(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.get("/debug/db-tables", async (_req, res) => {
  try {
    const { rows } = await pool.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY 1`);
    res.json(rows.map(r => r.table_name));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/debug/db-counts", async (_req, res) => {
  try {
    const q = (t) => pool.query(`SELECT COUNT(*)::int AS c FROM ${t}`).then(r => r.rows[0].c).catch(()=>null);
    const [a,b,c] = await Promise.all([q("products"), q("pedidos"), q("push_subs")]);
    res.json({ products:a, pedidos:b, push_subs:c });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/debug/db-ping", async (_req, res) => {
  try { await pool.query("SELECT 1"); res.json({ ok:true }); }
  catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

function newId() {
  try { return require("crypto").randomUUID(); } catch { return String(Date.now()); }
}

/* --------------------- Normalizadores de JSON (⚠️ importante) ---------------- */
function parseJSONSafely(v) {
  if (typeof v !== "string") return v;
  const s = v.trim();
  if (!s) return v;
  // aceita strings começando com { ou [ e tenta parse
  if ((s.startsWith("{") && s.endsWith("}")) || (s.startsWith("[") && s.endsWith("]"))) {
    try { return JSON.parse(s); } catch { return v; }
  }
  return v;
}
function normalizePedidoInput(pedido) {
  const out = { ...pedido };

  // cliente pode vir como string JSON
  out.cliente = parseJSONSafely(out.cliente);
  if (!out.cliente || typeof out.cliente !== "object") out.cliente = {};

  // itens pode vir: array de objetos OU array de strings JSON
  let itens = parseJSONSafely(out.itens);
  if (!Array.isArray(itens)) itens = [];

  itens = itens.map(it => {
    const obj = parseJSONSafely(it);
    if (obj && typeof obj === "object") return obj;
    return null;
  }).filter(Boolean);

  out.itens = itens;

  // total sempre número
  out.total = Number(String(out.total ?? "0").replace(",", ".")) || 0;

  return out;
}

/* ------------------------------- DAO Produtos -------------------------------- */
const Produtos = {
  async listar() {
    try {
      const { rows } = await pool.query(`SELECT id, nome, preco, estoque, imagem FROM products ORDER BY created_at DESC`);
      return rows.map(r => ({ ...r, preco: Number(r.preco), estoque: Number(r.estoque) }));
    } catch (e) {
      if (/relation .*products.* does not exist/i.test(e?.message || "")) {
        await ensureSchema();
        const { rows } = await pool.query(`SELECT id, nome, preco, estoque, imagem FROM products ORDER BY created_at DESC`);
        return rows.map(r => ({ ...r, preco: Number(r.preco), estoque: Number(r.estoque) }));
      }
      throw e;
    }
  },
  async criar(data) {
    const id = newId();
    const nome = String(data.nome || "").trim();
    if (!nome) throw new Error("nome obrigatório");
    const preco = Number(data.preco || 0) || 0;
    const estoque = parseInt(data.estoque || 0) || 0;
    const imagem = data.imagem || "";
    const q = `INSERT INTO products (id,nome,preco,estoque,imagem) VALUES ($1,$2,$3,$4,$5) RETURNING id,nome,preco,estoque,imagem`;
    const { rows } = await pool.query(q, [id, nome, preco, estoque, imagem]);
    return { ...rows[0], preco: Number(rows[0].preco), estoque: Number(rows[0].estoque) };
  },
  async atualizar(id, patch) {
    const { rows } = await pool.query(
      `UPDATE products
         SET nome   = COALESCE($2, nome),
             preco  = COALESCE($3, preco),
             estoque= COALESCE($4, estoque),
             imagem = COALESCE($5, imagem)
       WHERE id = $1
   RETURNING id,nome,preco,estoque,imagem`,
      [
        id,
        patch.nome   !== undefined ? String(patch.nome) : null,
        patch.preco  !== undefined ? Number(patch.preco) : null,
        patch.estoque!== undefined ? parseInt(patch.estoque) : null,
        patch.imagem !== undefined ? patch.imagem : null,
      ]
    );
    return rows[0] ? { ...rows[0], preco: Number(rows[0].preco), estoque: Number(rows[0].estoque) } : null;
  },
  async remover(id) {
    const r = await pool.query(`DELETE FROM products WHERE id=$1`, [id]);
    return r.rowCount > 0;
  },
  async baixarEstoqueItens(itens, client) {
    for (const it of itens || []) {
      await client.query(`UPDATE products SET estoque = GREATEST(0, estoque - $2) WHERE id=$1`, [
        String(it.id),
        Number(it.quantidade || 0),
      ]);
    }
  },
};

/* -------------------------------- DAO Pedidos -------------------------------- */
const Pedidos = {
  async listar() {
    try {
      const { rows } = await pool.query(`SELECT * FROM pedidos ORDER BY created_at DESC`);
      return rows.map(r => ({ ...r, total: Number(r.total) }));
    } catch (e) {
      if (/relation .*pedidos.* does not exist/i.test(e?.message || "")) {
        await ensureSchema();
        const { rows } = await pool.query(`SELECT * FROM pedidos ORDER BY created_at DESC`);
        return rows.map(r => ({ ...r, total: Number(r.total) }));
      }
      throw e;
    }
  },
  async obter(id) {
    const { rows } = await pool.query(`SELECT * FROM pedidos WHERE id=$1`, [id]);
    return rows[0] ? { ...rows[0], total: Number(rows[0].total) } : null;
  },
  async criar(pedidoRaw) {
    const pedido = normalizePedidoInput(pedidoRaw); // 👈 normaliza tudo
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const id = newId();
      const q = `INSERT INTO pedidos (id, cliente, itens, total, status, pix)
                 VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`;
      const vals = [id, pedido.cliente, pedido.itens, pedido.total, pedido.status || "Pendente", pedido.pix || null];
      const { rows } = await client.query(q, vals);
      await Produtos.baixarEstoqueItens(pedido.itens, client);
      await client.query("COMMIT");
      const r = rows[0];
      return { ...r, total: Number(r.total) };
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  },
  async atualizarStatus(id, status) {
    const { rows } = await pool.query(`UPDATE pedidos SET status=$2 WHERE id=$1 RETURNING *`, [id, status || "Pendente"]);
    return rows[0] ? { ...rows[0], total: Number(rows[0].total) } : null;
  },
  async remover(id) {
    const r = await pool.query(`DELETE FROM pedidos WHERE id=$1`, [id]);
    return r.rowCount > 0;
  },
};

/* ------------------------ DAO Push Subscriptions (opcional) ------------------ */
const PushSubs = {
  async listar() {
    const { rows } = await pool.query(`SELECT sub FROM push_subs`);
    return rows.map(r => r.sub);
  },
  async addOrKeep(sub) {
    await pool.query(
      `INSERT INTO push_subs (endpoint, sub) VALUES ($1,$2)
         ON CONFLICT (endpoint) DO UPDATE SET sub=EXCLUDED.sub`,
      [sub.endpoint, sub]
    );
  },
  async remover(endpoint) {
    await pool.query(`DELETE FROM push_subs WHERE endpoint=$1`, [endpoint]);
  },
};

/* -------------------------------- API PIX ----------------------------------- */
app.get("/api/chave-pix", (_req, res) => {
  res.json({ chave: chavePix, nome: nomeLoja, cidade });
});

app.get("/api/pix/:valor/:txid?", async (req, res) => {
  try {
    const raw = String(req.params.valor).replace(",", ".");
    const valor = Number(raw);
    if (!Number.isFinite(valor) || valor < 0.01) {
      return res.status(400).json({ error: "Valor inválido (mínimo 0,01)" });
    }
    const txid = (req.params.txid || "PIX" + Date.now()).slice(0, 25);

    const qrCodePix = QrCodePix({
      version: "01",
      key: chavePix,
      name: nomeLoja,
      city: cidade,
      transactionId: txid,
      value: Number(valor.toFixed(2)),
    });

    const payload = qrCodePix.payload().replace(/\s+/g, "");
    const qrCodeImage = await qrCodePix.base64();

    res.set("Cache-Control", "no-store");
    res.json({ payload, qrCodeImage, txid, chave: chavePix });
  } catch (err) {
    console.error("Erro ao gerar PIX:", err);
    res.status(500).json({ error: "Falha ao gerar QR Code PIX" });
  }
});

/* ------------------------------- Produtos ----------------------------------- */
// público
app.get("/api/produtos", async (_req, res) => {
  try { res.json(await Produtos.listar()); }
  catch (e) {
    console.error("/api/produtos:", e?.message);
    res.status(500).json({ error: "Falha ao listar produtos", detail: e?.message });
  }
});
// admin
app.post("/api/produtos", ...adminOnly, async (req, res) => {
  try { res.json(await Produtos.criar(req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message || "Falha ao criar produto" }); }
});
app.put("/api/produtos/:id", ...adminOnly, async (req, res) => {
  try {
    const upd = await Produtos.atualizar(String(req.params.id), req.body || {});
    if (!upd) return res.status(404).json({ error: "Produto não encontrado" });
    res.json(upd);
  } catch (e) { res.status(500).json({ error: "Falha ao atualizar produto" }); }
});
app.patch("/api/produtos/:id", ...adminOnly, async (req, res) => {
  try {
    const upd = await Produtos.atualizar(String(req.params.id), req.body || {});
    if (!upd) return res.status(404).json({ error: "Produto não encontrado" });
    res.json(upd);
  } catch (e) { res.status(500).json({ error: "Falha ao atualizar produto" }); }
});
app.delete("/api/produtos/:id", ...adminOnly, async (req, res) => {
  try {
    const ok = await Produtos.remover(String(req.params.id));
    if (!ok) return res.status(404).json({ error: "Produto não encontrado" });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: "Falha ao deletar produto" }); }
});
app.post("/api/produtos/update", ...adminOnly, async (req, res) => {
  try {
    const { id, ...rest } = req.body || {};
    if (!id) return res.status(400).json({ error: "id obrigatório" });
    const upd = await Produtos.atualizar(String(id), rest);
    if (!upd) return res.status(404).json({ error: "Produto não encontrado" });
    res.json(upd);
  } catch (e) { res.status(500).json({ error: "Falha ao atualizar produto" }); }
});

/* --------------------------- Rotas de Push (opcional) ----------------------- */
app.get("/api/push/public-key", (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC || "" });
});
app.post("/api/push/subscribe", async (req, res) => {
  try {
    const sub = req.body;
    if (!sub?.endpoint) return res.status(400).json({ error: "assinatura inválida" });
    await PushSubs.addOrKeep(sub);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "falha ao salvar assinatura" }); }
});
app.post("/api/push/unsubscribe", async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: "endpoint ausente" });
    await PushSubs.remover(endpoint);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: "falha ao remover assinatura" }); }
});

async function sendPushToAll(title, body, data = {}) {
  if (!webpush || !VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const subs = await PushSubs.listar();
  if (!subs.length) return;
  const payload = JSON.stringify({ title, body, data });
  await Promise.all(
    subs.map(async (sub) => {
      try { await webpush.sendNotification(sub, payload); }
      catch (err) {
        console.warn("[push] assinatura inválida:", err?.statusCode);
        try { if (sub?.endpoint) await PushSubs.remover(sub.endpoint); } catch {}
      }
    })
  );
}

/* -------------------------------- Pedidos ----------------------------------- */
// admin
app.get("/api/pedidos", ...adminOnly, async (_req, res) => {
  try { res.json(await Pedidos.listar()); }
  catch (e) {
    console.error("/api/pedidos GET:", e?.message);
    res.status(500).json({ error: "Falha ao listar pedidos", detail: e?.message });
  }
});
app.get("/api/pedidos/:id", ...adminOnly, async (req, res) => {
  try {
    const p = await Pedidos.obter(String(req.params.id));
    if (!p) return res.status(404).json({ error: "Pedido não encontrado" });
    res.json(p);
  } catch { res.status(500).json({ error: "Falha ao obter pedido" }); }
});
app.put("/api/pedidos/:id/status", ...adminOnly, async (req, res) => {
  try {
    const p = await Pedidos.atualizarStatus(String(req.params.id), req.body?.status);
    if (!p) return res.status(404).json({ error: "Pedido não encontrado" });
    await sendTelegramMessage(`🔔 Pedido #${p.id} atualizado para: <b>${p.status}</b>`);
    res.json(p);
  } catch { res.status(500).json({ error: "Falha ao atualizar status" }); }
});
app.delete("/api/pedidos/:id", ...adminOnly, async (req, res) => {
  try {
    const ok = await Pedidos.remover(String(req.params.id));
    if (!ok) return res.status(404).json({ error: "Pedido não encontrado" });
    res.json({ success: true });
  } catch { res.status(500).json({ error: "Falha ao deletar pedido" }); }
});

// público
app.post("/api/pedidos", async (req, res) => {
  try {
    // Normaliza tudo que possa vir como string JSON
    const pedido = normalizePedidoInput({ ...req.body, status: "Pendente" });

    // Gera PIX (tentativa)
    try {
      if (pedido.total >= 0.01) {
        const txid = ("PED" + Date.now()).slice(0, 25);
        const qrCodePix = QrCodePix({
          version: "01", key: chavePix, name: nomeLoja, city: cidade, transactionId: txid, value: Number(pedido.total.toFixed(2)),
        });
        pedido.pix = {
          payload: qrCodePix.payload().replace(/\s+/g, ""),
          qrCodeImage: await qrCodePix.base64(),
          txid, chave: chavePix,
        };
      } else {
        pedido.pix = null;
      }
    } catch (err) {
      console.error("Erro ao gerar PIX do pedido:", err?.message);
      pedido.pix = null;
    }

    const saved = await Pedidos.criar(pedido);

    // Notificações
    const nome = pedido?.cliente?.nome || "Cliente";
    const endereco = pedido?.cliente?.endereco || "-";
    const itensTxt = (pedido.itens || []).map(i => `${i.nome} x${i.quantidade}`).join(", ");
    const totalBR = Number(pedido.total || 0).toFixed(2).replace(".", ",");

    sendTelegramMessage(
      `📦 <b>Novo pedido</b>\n` +
      `#${saved.id}\n` +
      `👤 ${nome}\n` +
      `📍 ${endereco}\n` +
      `🧾 ${itensTxt || "-"}\n` +
      `💰 R$ ${totalBR}\n` +
      `${pedido.pix ? "💳 PIX" : "💵 Outro"}`
    ).catch(()=>{});

    sendPushToAll("Novo pedido!", `#${saved.id} · ${nome} · R$ ${totalBR}`, { id: saved.id }).catch(()=>{});

    res.json(saved);
  } catch (e) {
    console.error("POST /api/pedidos error:", e);
    res.status(500).json({ error: "Falha ao criar pedido", detail: e?.message });
  }
});

/* --------------------------------- Start ------------------------------------ */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
