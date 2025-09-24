// server.js – Railway + Postgres + PIX + Produtos/Pedidos + Telegram + (opcional) Web Push + Backup/Restore
const express = require("express");
const path = require("path");
const cors = require("cors");
const { QrCodePix } = require("qrcode-pix");

// web-push é opcional; só é usado se VAPID_* estiverem definidos
let webpush = null;
try { webpush = require("web-push"); } catch { /* opcional */ }

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------- Basic Auth --------------------------------- */
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "senha123"; // ⚠️ defina no Railway
const ADMIN_REALM = "Adega Admin";

function basicAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const [type, b64] = h.split(" ");
  if (type === "Basic" && b64) {
    const [user, pass] = Buffer.from(b64, "base64").toString().split(":");
    if (user === ADMIN_USER && pass === ADMIN_PASS) return next();
  }
  res.set("WWW-Authenticate", `Basic realm="${ADMIN_REALM}", charset="UTF-8"`);
  return res.status(401).send("Autenticação requerida");
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
// ⚠️ Se quiser usar CNPJ em vez de telefone, troque a chave aqui:
const chavePix = "55160826000100";   // CNPJ SEM máscara
const nomeLoja = "RS LUBRIFICANTES"; // máx ~25 chars
const cidade   = "SAMBAIBA";         // máx ~15 chars

/* ----------------------------- Push Web (opcional) --------------------------- */
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT     || "mailto:suporte@exemplo.com";

if (webpush && VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
} else if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.warn("[web-push] sem VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY — recurso de push web ficará inativo.");
}

/* ----------------------- Telegram (notificação confiável) ------------------- */
const _fetch = (...args) =>
  (globalThis.fetch
    ? globalThis.fetch(...args)
    : import("node-fetch").then((m) => m.default(...args)));

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID    || "";

async function sendTelegramMessage(text) {
  try {
    if (!TG_TOKEN || !TG_CHAT) return;
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    await _fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.warn("[telegram] falhou:", e?.message);
  }
}

/* ------------------------------- Banco (Postgres) ---------------------------- */
const { Pool } = require("pg");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
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
ensureSchema().catch(e => console.error("Falha ensureSchema:", e));

function newId() {
  try { return require("crypto").randomUUID(); } catch { return String(Date.now()); }
}

/* ------------------------------- DAO Produtos -------------------------------- */
const Produtos = {
  async listar() {
    const { rows } = await pool.query(`SELECT id, nome, preco, estoque, imagem FROM products ORDER BY created_at DESC`);
    return rows.map(r => ({ ...r, preco: Number(r.preco), estoque: Number(r.estoque) }));
  },
  async criar(data) {
    const id = newId();
    const nome = String(data.nome || data.name || "");
    if (!nome) throw new Error("nome obrigatório");
    const preco = Number(data.preco ?? data.price ?? 0) || 0;
    const estoque = parseInt(data.estoque ?? data.stock ?? 0) || 0;
    const imagem = data.imagem ?? data.image_url ?? "";
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
      const q = `UPDATE products SET estoque = GREATEST(0, estoque - $2) WHERE id=$1`;
      await client.query(q, [String(it.id), Number(it.quantidade || 0)]);
    }
  }
};

/* -------------------------------- DAO Pedidos -------------------------------- */
const Pedidos = {
  async listar() {
    const { rows } = await pool.query(`SELECT * FROM pedidos ORDER BY created_at DESC`);
    return rows.map(r => ({ ...r, total: Number(r.total) }));
  },
  async obter(id) {
    const { rows } = await pool.query(`SELECT * FROM pedidos WHERE id=$1`, [id]);
    return rows[0] ? { ...rows[0], total: Number(rows[0].total) } : null;
  },
  async criar(pedido) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const id = newId();
      const total = Number(String(pedido.total || "0").replace(",", ".")) || 0;

      const q = `INSERT INTO pedidos (id, cliente, itens, total, status, pix)
                 VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`;
      const vals = [id, pedido.cliente || {}, pedido.itens || [], total, pedido.status || "Pendente", pedido.pix || null];
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
    const { rows } = await pool.query(
      `UPDATE pedidos SET status=$2 WHERE id=$1 RETURNING *`,
      [id, status || "Pendente"]
    );
    return rows[0] ? { ...rows[0], total: Number(rows[0].total) } : null;
  },
  async remover(id) {
    const r = await pool.query(`DELETE FROM pedidos WHERE id=$1`, [id]);
    return r.rowCount > 0;
  }
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
  }
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
// GET é público
app.get("/api/produtos", async (_req, res) => {
  try {
    const list = await Produtos.listar();
    res.json(list);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Falha ao listar produtos" });
  }
});

// Criar (admin)
app.post("/api/produtos", ...adminOnly, async (req, res) => {
  try {
    const novo = await Produtos.criar(req.body || {});
    res.json(novo);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message || "Falha ao criar produto" });
  }
});

// Atualizar (admin)
app.put("/api/produtos/:id", ...adminOnly, async (req, res) => {
  try {
    const upd = await Produtos.atualizar(String(req.params.id), req.body || {});
    if (!upd) return res.status(404).json({ error: "Produto não encontrado" });
    res.json(upd);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Falha ao atualizar produto" });
  }
});
app.patch("/api/produtos/:id", ...adminOnly, async (req, res) => {
  try {
    const upd = await Produtos.atualizar(String(req.params.id), req.body || {});
    if (!upd) return res.status(404).json({ error: "Produto não encontrado" });
    res.json(upd);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Falha ao atualizar produto" });
  }
});

// Deletar (admin)
app.delete("/api/produtos/:id", ...adminOnly, async (req, res) => {
  try {
    const ok = await Produtos.remover(String(req.params.id));
    if (!ok) return res.status(404).json({ error: "Produto não encontrado" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Falha ao deletar produto" });
  }
});

// Fallback POST /api/produtos/update (admin)
app.post("/api/produtos/update", ...adminOnly, async (req, res) => {
  try {
    const { id, ...rest } = req.body || {};
    if (!id) return res.status(400).json({ error: "id obrigatório" });
    const upd = await Produtos.atualizar(String(id), rest);
    if (!upd) return res.status(404).json({ error: "Produto não encontrado" });
    res.json(upd);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Falha ao atualizar produto" });
  }
});

/* --------------------------- Rotas de Push (opcional) ----------------------- */
app.get("/api/push/public-key", (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC || "" });
});
app.post("/api/push/subscribe", async (req, res) => {
  try {
    const sub = req.body; // { endpoint, keys:{p256dh, auth} }
    if (!sub?.endpoint) return res.status(400).json({ error: "assinatura inválida" });
    await PushSubs.addOrKeep(sub);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "falha ao salvar assinatura" });
  }
});
app.post("/api/push/unsubscribe", async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: "endpoint ausente" });
    await PushSubs.remover(endpoint);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "falha ao remover assinatura" });
  }
});

async function sendPushToAll(title, body, data = {}) {
  if (!webpush || !VAPID_PUBLIC || !VAPID_PRIVATE) return;
  const subs = await PushSubs.listar();
  if (!subs.length) return;
  const payload = JSON.stringify({ title, body, data });
  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
      } catch (err) {
        console.warn("[push] assinatura inválida:", err?.statusCode);
        try { if (sub?.endpoint) await PushSubs.remover(sub.endpoint); } catch {}
      }
    })
  );
}

/* -------------------------------- Pedidos ----------------------------------- */
// Admin
app.get("/api/pedidos", ...adminOnly, async (_req, res) => {
  try { res.json(await Pedidos.listar()); }
  catch (e) { console.error(e); res.status(500).json({ error: "Falha ao listar pedidos" }); }
});
app.get("/api/pedidos/:id", ...adminOnly, async (req, res) => {
  try {
    const p = await Pedidos.obter(String(req.params.id));
    if (!p) return res.status(404).json({ error: "Pedido não encontrado" });
    res.json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Falha ao obter pedido" });
  }
});
app.put("/api/pedidos/:id/status", ...adminOnly, async (req, res) => {
  try {
    const p = await Pedidos.atualizarStatus(String(req.params.id), req.body?.status);
    if (!p) return res.status(404).json({ error: "Pedido não encontrado" });
    sendTelegramMessage(`🔔 Pedido #${p.id} atualizado para: <b>${p.status}</b>`).catch(()=>{});
    res.json(p);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Falha ao atualizar status" });
  }
});
app.delete("/api/pedidos/:id", ...adminOnly, async (req, res) => {
  try {
    const ok = await Pedidos.remover(String(req.params.id));
    if (!ok) return res.status(404).json({ error: "Pedido não encontrado" });
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Falha ao deletar pedido" });
  }
});

// Público: criar pedido
app.post("/api/pedidos", async (req, res) => {
  try {
    const pedido = { ...req.body };
    pedido.id = newId();
    pedido.status = "Pendente";

    // Gera PIX
    try {
      const rawTotal = String(pedido.total).replace(",", ".");
      const valor = Number(rawTotal);
      if (!Number.isFinite(valor) || valor < 0.01) throw new Error("Valor do pedido inválido");

      const txid = ("PED" + pedido.id).slice(0, 25);
      const qrCodePix = QrCodePix({
        version: "01",
        key: chavePix,
        name: nomeLoja,
        city: cidade,
        transactionId: txid,
        value: Number(valor.toFixed(2)),
      });

      pedido.pix = {
        payload: qrCodePix.payload().replace(/\s+/g, ""),
        qrCodeImage: await qrCodePix.base64(),
        txid,
        chave: chavePix,
      };
    } catch (err) {
      console.error("Erro ao gerar PIX do pedido:", err);
      pedido.pix = null;
    }

    // Salva e baixa estoque (transação)
    const saved = await Pedidos.criar(pedido);

    // Notificações
    const nome = pedido?.cliente?.nome || "Cliente";
    const endereco = pedido?.cliente?.endereco || "-";
    const itensTxt = (pedido.itens || []).map(i => `${i.nome} x${i.quantidade}`).join(", ");
    const totalBR = Number(pedido.total).toFixed(2).replace(".", ",");

    sendTelegramMessage(
      `📦 <b>Novo pedido</b>\n#${saved.id}\n👤 ${nome}\n📍 ${endereco}\n🧾 ${itensTxt || "-"}\n💰 R$ ${totalBR}\n${pedido.pix ? "💳 PIX" : "💵 Outro"}`
    ).catch(()=>{});

    sendPushToAll("Novo pedido!", `#${saved.id} · ${nome} · R$ ${totalBR}`, { id: saved.id }).catch(()=>{});

    res.json(saved);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Falha ao criar pedido" });
  }
});

/* ---------------- Debug/Backup/Restore (via Postgres) ----------------------- */
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || "segredo123"; // ⚠️ defina no Railway

// GET /api/backup?token=...
app.get("/api/backup", ...adminOnly, async (req, res) => {
  if (req.query.token !== DEBUG_TOKEN) {
    return res.status(403).json({ error: "Acesso negado. Token inválido." });
  }
  try {
    const [prods, peds, subs] = await Promise.all([
      Produtos.listar(),
      Pedidos.listar(),
      PushSubs.listar()
    ]);
    const out = { produtos: prods, pedidos: peds, pushSubs: subs };
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Disposition", `attachment; filename=db-backup-${ts}.json`);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(out, null, 2));
  } catch (err) {
    res.status(500).json({ error: "Erro ao gerar backup", detalhe: err.message });
  }
});

// POST /api/restore?token=...&mode=replace|merge
app.post("/api/restore", ...adminOnly, async (req, res) => {
  if (req.query.token !== DEBUG_TOKEN) {
    return res.status(403).json({ error: "Acesso negado. Token inválido." });
  }
  const incoming = req.body && typeof req.body === "object" ? req.body : {};
  const dados = {
    produtos: Array.isArray(incoming.produtos) ? incoming.produtos : [],
    pedidos:  Array.isArray(incoming.pedidos)  ? incoming.pedidos  : [],
    pushSubs: Array.isArray(incoming.pushSubs) ? incoming.pushSubs : [],
  };
  const mode = String(req.query.mode || "replace").toLowerCase(); // replace|merge

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    if (mode === "replace") {
      await client.query("DELETE FROM push_subs");
      await client.query("DELETE FROM pedidos");
      await client.query("DELETE FROM products");
    }

    // produtos
    for (const p of dados.produtos) {
      await client.query(
        `INSERT INTO products (id,nome,preco,estoque,imagem)
           VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (id) DO UPDATE
             SET nome=EXCLUDED.nome,preco=EXCLUDED.preco,estoque=EXCLUDED.estoque,imagem=EXCLUDED.imagem`,
        [String(p.id || newId()), String(p.nome || p.name || ""), Number(p.preco ?? p.price ?? 0) || 0, parseInt(p.estoque ?? p.stock ?? 0) || 0, p.imagem ?? p.image_url ?? ""]
      );
    }

    // pedidos
    for (const d of dados.pedidos) {
      await client.query(
        `INSERT INTO pedidos (id,cliente,itens,total,status,pix)
           VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (id) DO UPDATE
             SET cliente=EXCLUDED.cliente,itens=EXCLUDED.itens,total=EXCLUDED.total,status=EXCLUDED.status,pix=EXCLUDED.pix`,
        [String(d.id || newId()), d.cliente || {}, d.itens || [], Number(d.total || 0) || 0, String(d.status || "Pendente"), d.pix || null]
      );
    }

    // push subs
    for (const s of dados.pushSubs) {
      if (!s?.endpoint) continue;
      await client.query(
        `INSERT INTO push_subs (endpoint, sub)
           VALUES ($1,$2)
         ON CONFLICT (endpoint) DO UPDATE SET sub=EXCLUDED.sub`,
        [s.endpoint, s]
      );
    }

    await client.query("COMMIT");
    res.json({
      ok: true,
      mode,
      counts: {
        produtos: dados.produtos.length,
        pedidos:  dados.pedidos.length,
        pushSubs: dados.pushSubs.length,
      }
    });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: "Erro ao restaurar", detalhe: err.message });
  } finally {
    client.release();
  }
});

/* --------------------------------- Start ------------------------------------ */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
