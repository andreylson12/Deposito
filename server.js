// server.js – Railway + PIX + Produtos/Pedidos + Telegram + (opcional) Web Push + Backup/Restore
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { QrCodePix } = require("qrcode-pix");

// web-push é opcional; só é usado se VAPID_* estiverem definidos
let webpush = null;
try { webpush = require("web-push"); } catch { /* opcional */ }

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------- Basic Auth --------------------------------- */
// Credenciais e opções
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "senha123"; // ⚠️ defina no Railway
const ADMIN_REALM = "Adega Admin";

// Middleware simples de Basic Auth
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

// Use este alias SÓ onde realmente precisa proteger
const adminOnly = [basicAuth];

/* -------------------------------- Middlewares -------------------------------- */
app.use(express.json({ limit: "5mb" })); // aceita até ~5MB de JSON (para restore)
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  })
);

/* ------------------------------ Arquivos estáticos --------------------------- */
/**
 * MUITO IMPORTANTE: desabilitamos o 'index' automático do express.static
 * para garantir que /index.html NÃO seja servido sem passar no basicAuth.
 * Assim, roteamos /, /index, /index.html manualmente (com auth).
 */
app.use(
  express.static(path.join(__dirname, "public"), {
    index: false, // impede servir index.html automaticamente
  })
);

/* -------------------------- Rotas de páginas (UI) ---------------------------- */
// 🔐 Painel administrativo protegido por senha
app.get(["/", "/index", "/index.html"], basicAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Página pública (sem senha)
app.get(["/delivery", "/delivery.html"], (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "delivery.html"));
});

app.get("/health", (_req, res) => res.json({ ok: true }));

/* ------------------------------- Banco em arquivo ---------------------------- */
// Use DB_FILE=/data/db.json no Railway (com Volume montado em /data)
const DB_FILE = process.env.DB_FILE || path.join(__dirname, "db.json");

// Garante que a pasta do banco existe
const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

function ensureDBShape(db) {
  db = db && typeof db === "object" ? db : {};
  db.produtos = Array.isArray(db.produtos) ? db.produtos : [];
  db.pedidos  = Array.isArray(db.pedidos)  ? db.pedidos  : [];
  db.pushSubs = Array.isArray(db.pushSubs) ? db.pushSubs : [];
  return db;
}

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      const blank = ensureDBShape({});
      fs.writeFileSync(DB_FILE, JSON.stringify(blank, null, 2));
      return blank;
    }
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return ensureDBShape(parsed);
  } catch (err) {
    console.warn("[db] erro ao ler/parsear, recriando arquivo:", err?.message);
    const blank = ensureDBShape({});
    fs.writeFileSync(DB_FILE, JSON.stringify(blank, null, 2));
    return blank;
  }
}

function saveDB(db) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(ensureDBShape(db), null, 2));
  } catch (err) {
    console.error("[db] erro ao salvar:", err?.message);
  }
}

/* -------------------------------- Config PIX -------------------------------- */
const chavePix = "99 991842200";     // <- sua chave telefone
const nomeLoja = "ANDREYLSON SODRE";
const cidade   = "SAMBAIBA";

/* ----------------------------- Push Web (opcional) --------------------------- */
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT     || "mailto:suporte@exemplo.com";

if (webpush && VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
} else if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
  console.warn("[web-push] sem VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY — recurso de push web ficará inativo.");
}

/** Envia notificação web para todos inscritos; ignora se não houver VAPID/chaves */
async function sendPushToAll(title, body, data = {}) {
  if (!webpush || !VAPID_PUBLIC || !VAPID_PRIVATE) return;

  const db = loadDB();
  const subs = db.pushSubs || [];
  if (subs.length === 0) return;

  const payload = JSON.stringify({ title, body, data });
  const stillValid = [];

  await Promise.all(
    subs.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload);
        stillValid.push(sub);
      } catch (err) {
        // 404/410 -> assinatura expirada/inválida
        console.warn("[push] assinatura removida:", err?.statusCode);
      }
    })
  );

  if (stillValid.length !== subs.length) {
    db.pushSubs = stillValid;
    saveDB(db);
  }
}

/* --------------------------- Rotas de Push (opcional) ----------------------- */
// Deixe públicas se pretende usar push na página pública.
// Se preferir que só o admin assine, troque por "...adminOnly".
app.get("/api/push/public-key", (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC || "" });
});
app.post("/api/push/subscribe", (req, res) => {
  try {
    const sub = req.body; // { endpoint, keys:{p256dh, auth} }
    if (!sub?.endpoint) return res.status(400).json({ error: "assinatura inválida" });

    const db = loadDB();
    const exists = db.pushSubs.some((s) => s.endpoint === sub.endpoint);
    if (!exists) db.pushSubs.push(sub);
    saveDB(db);

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "falha ao salvar assinatura" });
  }
});
app.post("/api/push/unsubscribe", (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: "endpoint ausente" });
    const db = loadDB();
    db.pushSubs = (db.pushSubs || []).filter((s) => s.endpoint !== endpoint);
    saveDB(db);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "falha ao remover assinatura" });
  }
});

/* ----------------------- Telegram (notificação confiável) ------------------- */
// usa fetch nativo do Node 18+; com fallback leve para node-fetch se necessário
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

/* -------------------------------- API PIX ----------------------------------- */
// **PÚBLICAS** – usadas pela página delivery
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
// GET é **público** (listagem para o delivery)
app.get("/api/produtos", (_req, res) => {
  const db = loadDB();
  res.json(db.produtos);
});

// Criação/remoção são **admin**
app.post("/api/produtos", ...adminOnly, (req, res) => {
  const db = loadDB();
  const novo = { ...req.body, id: Date.now() };
  db.produtos.push(novo);
  saveDB(db);
  res.json(novo);
});

app.delete("/api/produtos/:id", ...adminOnly, (req, res) => {
  const db = loadDB();
  const id = Number(req.params.id);
  db.produtos = db.produtos.filter((p) => p.id !== id);
  saveDB(db);
  res.json({ success: true });
});

/* -------------------------------- Pedidos ----------------------------------- */
// **Admin**: listar, ver, atualizar status, deletar
app.get("/api/pedidos", ...adminOnly, (_req, res) => {
  const db = loadDB();
  res.json(db.pedidos);
});
app.get("/api/pedidos/:id", ...adminOnly, (req, res) => {
  const db = loadDB();
  const id = Number(req.params.id);
  const pedido = db.pedidos.find((p) => p.id === id);
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
  res.json(pedido);
});
app.put("/api/pedidos/:id/status", ...adminOnly, (req, res) => {
  const db = loadDB();
  const id = Number(req.params.id);
  const pedido = db.pedidos.find((p) => p.id === id);
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });

  pedido.status = req.body.status || pedido.status;
  saveDB(db);

  sendTelegramMessage(`🔔 Pedido #${id} atualizado para: <b>${pedido.status}</b>`).catch(() => {});
  res.json(pedido);
});
app.delete("/api/pedidos/:id", ...adminOnly, (req, res) => {
  const db = loadDB();
  const id = Number(req.params.id);
  db.pedidos = db.pedidos.filter((p) => p.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// **PÚBLICO**: criar pedido (usado pelo delivery)
app.post("/api/pedidos", async (req, res) => {
  const db = loadDB();
  const pedido = { ...req.body, id: Date.now(), status: "Pendente" };

  // baixa estoque com segurança
  if (Array.isArray(pedido.itens) && db.produtos.length) {
    for (const prod of db.produtos) {
      const item = pedido.itens.find((i) => i.id === prod.id);
      if (item) {
        prod.estoque = Math.max(
          0,
          Number(prod.estoque || 0) - Number(item.quantidade || 0)
        );
      }
    }
  }

  // gera PIX
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

  db.pedidos.push(pedido);
  saveDB(db);

  // Notificação por Telegram (confiável em 2º plano)
  const nome = pedido?.cliente?.nome || "Cliente";
  const endereco = pedido?.cliente?.endereco || "-";
  const itensTxt = (pedido.itens || [])
    .map((i) => `${i.nome} x${i.quantidade}`)
    .join(", ");
  const totalBR = Number(pedido.total).toFixed(2).replace(".", ",");

  sendTelegramMessage(
    `📦 <b>Novo pedido</b>\n` +
      `#${pedido.id}\n` +
      `👤 ${nome}\n` +
      `📍 ${endereco}\n` +
      `🧾 ${itensTxt || "-"}\n` +
      `💰 R$ ${totalBR}\n` +
      `${pedido.pix ? "💳 PIX" : "💵 Outro"}`
  ).catch(() => {});

  // Push Web (opcional)
  sendPushToAll("Novo pedido!", `#${pedido.id} · ${nome} · R$ ${totalBR}`, {
    id: pedido.id,
  }).catch(() => {});

  res.json(pedido);
});

/* ---------------- Debug/Backup/Restore (protegidos por token) --------------- */
const DEBUG_TOKEN = process.env.DEBUG_TOKEN || "segredo123"; // ⚠️ defina no Railway

// GET /api/debug-db?token=...
app.get("/api/debug-db", ...adminOnly, (req, res) => {
  const token = req.query.token;
  if (token !== DEBUG_TOKEN) {
    return res.status(403).json({ error: "Acesso negado. Forneça o token correto." });
  }
  try {
    const db = loadDB();
    res.json(db);
  } catch (e) {
    res.status(500).json({ error: "Erro ao ler DB", details: e.message });
  }
});

// GET /api/backup?token=...
app.get("/api/backup", ...adminOnly, (req, res) => {
  const token = req.query.token;
  if (token !== DEBUG_TOKEN) {
    return res.status(403).json({ error: "Acesso negado. Token inválido." });
  }
  try {
    const db = loadDB();
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    res.setHeader("Content-Disposition", `attachment; filename=db-backup-${ts}.json`);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(db, null, 2));
  } catch (err) {
    res.status(500).json({ error: "Erro ao gerar backup", detalhe: err.message });
  }
});

// POST /api/restore?token=...&mode=replace|merge
app.post("/api/restore", ...adminOnly, (req, res) => {
  const token = req.query.token;
  if (token !== DEBUG_TOKEN) {
    return res.status(403).json({ error: "Acesso negado. Token inválido." });
  }

  const incoming = req.body?.db && typeof req.body.db === "object" ? req.body.db : req.body;
  const data = ensureDBShape(incoming);

  if (!Array.isArray(data.produtos) || !Array.isArray(data.pedidos) || !Array.isArray(data.pushSubs)) {
    return res.status(400).json({ error: "Formato inválido. Esperado objeto com produtos[], pedidos[], pushSubs[]." });
  }

  const mode = String(req.query.mode || "replace").toLowerCase(); // replace | merge
  try {
    const current = loadDB();

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = DB_FILE + ".bak-" + ts;
    fs.copyFileSync(DB_FILE, backupPath);

    let finalDB;

    if (mode === "merge") {
      const byId = (arr) => Object.fromEntries((arr || []).map(x => [String(x.id), x]));
      const mergeById = (base, inc) => {
        const map = byId(base);
        for (const item of inc || []) {
          const k = String(item.id);
          map[k] = item; // incoming vence
        }
        return Object.values(map);
      };
      const uniqBy = (arr, keyFn) => {
        const seen = new Set();
        const out = [];
        for (const v of arr || []) {
          const k = keyFn(v);
          if (!seen.has(k)) { seen.add(k); out.push(v); }
        }
        return out;
      };

      finalDB = {
        produtos: mergeById(current.produtos, data.produtos),
        pedidos:  mergeById(current.pedidos,  data.pedidos),
        pushSubs: uniqBy([...(current.pushSubs||[]), ...(data.pushSubs||[])], s => s?.endpoint || JSON.stringify(s))
      };

    } else { // replace (padrão)
      finalDB = data;
    }

    saveDB(finalDB);
    res.json({
      ok: true,
      mode,
      counts: {
        produtos: finalDB.produtos.length,
        pedidos:  finalDB.pedidos.length,
        pushSubs: finalDB.pushSubs.length,
      },
      backup: path.basename(backupPath),
    });
  } catch (err) {
    res.status(500).json({ error: "Erro ao restaurar", detalhe: err.message });
  }
});

/* --------------------------------- Start ------------------------------------ */
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
