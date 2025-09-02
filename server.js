// server.js – estável para Railway + Web Push (PWA) + PIX + produtos/pedidos
const express = require("express");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const webpush = require("web-push");
const { QrCodePix } = require("qrcode-pix");

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- Middlewares ----------------
app.use(express.json());
app.use(
  cors({ origin: true, methods: ["GET","POST","PUT","DELETE","OPTIONS"], credentials: true })
);

// ---------------- Arquivos estáticos ----------------
app.use(express.static(path.join(__dirname, "public")));

// Rotas explícitas (abrem páginas diretamente)
app.get(["/","/index","/index.html"], (_req,res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get(["/delivery","/delivery.html"], (_req,res) => {
  res.sendFile(path.join(__dirname, "public", "delivery.html"));
});

// Healthcheck
app.get("/health", (_req,res) => res.json({ ok:true }));

// ---------------- “Banco” em arquivo ----------------
const DB_FILE = path.join(__dirname, "db.json");
function loadDB(){
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
      DB_FILE,
      JSON.stringify({ produtos: [], pedidos: [], pushSubs: [] }, null, 2)
    );
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}
function saveDB(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// ---------------- Configuração PIX ----------------
const chavePix = "99 991842200";
const nomeLoja = "ANDREYLSON SODRE";
const cidade   = "SAMBAIBA";

// ---------------- Web Push (VAPID) ----------------
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT     || "mailto:suporte@exemplo.com";

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn("[web-push] AVISO: defina VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY no Railway (Variables).");
}

// helper: envia push para todos inscritos e remove os inválidos
async function sendPushToAll(title, body, data = {}) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return; // não envia se não tiver chaves
  const db = loadDB();
  const subs = db.pushSubs || [];
  if (subs.length === 0) return;

  const payload = JSON.stringify({ title, body, data });

  const stillValid = [];
  await Promise.all(subs.map(async (sub) => {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch (err) {
      // 404/410 => assinatura expirada/inválida
      console.warn("[push] removendo assinatura inválida:", err?.statusCode);
    }
  }));

  if (stillValid.length !== subs.length) {
    db.pushSubs = stillValid;
    saveDB(db);
  }
}

// ---------------- Rotas Push ----------------
app.get("/api/push/public-key", (_req, res) => {
  res.json({ publicKey: VAPID_PUBLIC || "" });
});

app.post("/api/push/subscribe", (req, res) => {
  try {
    const sub = req.body; // { endpoint, keys:{p256dh, auth} }
    if (!sub?.endpoint) return res.status(400).json({ error: "assinatura inválida" });

    const db = loadDB();
    db.pushSubs = db.pushSubs || [];
    const exists = db.pushSubs.some(s => s.endpoint === sub.endpoint);
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
    db.pushSubs = (db.pushSubs || []).filter(s => s.endpoint !== endpoint);
    saveDB(db);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "falha ao remover assinatura" });
  }
});

// ---------------- API PIX ----------------
app.get("/api/chave-pix", (_req,res) => {
  res.json({ chave: chavePix, nome: nomeLoja, cidade });
});

app.get("/api/pix/:valor/:txid?", async (req,res) => {
  try{
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
      value: Number(valor.toFixed(2))
    });

    const payload = qrCodePix.payload().replace(/\s+/g, "");
    const qrCodeImage = await qrCodePix.base64();

    res.set("Cache-Control", "no-store");
    res.json({ payload, qrCodeImage, txid, chave: chavePix });
  }catch(err){
    console.error("Erro ao gerar PIX:", err);
    res.status(500).json({ error: "Falha ao gerar QR Code PIX" });
  }
});

// ---------------- Produtos ----------------
app.get("/api/produtos", (_req,res) => {
  const db = loadDB();
  res.json(db.produtos || []);
});

app.post("/api/produtos", (req,res) => {
  const db = loadDB();
  const novo = { ...req.body, id: Date.now() };
  db.produtos.push(novo);
  saveDB(db);
  res.json(novo);
});

app.delete("/api/produtos/:id", (req,res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  db.produtos = (db.produtos || []).filter(p => p.id !== id);
  saveDB(db);
  res.json({ success:true });
});

// ---------------- Pedidos ----------------
app.get("/api/pedidos", (_req,res) => {
  const db = loadDB();
  res.json(db.pedidos || []);
});

app.get("/api/pedidos/:id", (req,res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  const pedido = (db.pedidos || []).find(p => p.id === id);
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
  res.json(pedido);
});

app.post("/api/pedidos", async (req,res) => {
  const db = loadDB();
  const pedido = { ...req.body, id: Date.now(), status: "Pendente" };

  // baixa estoque
  if (Array.isArray(pedido.itens)) {
    (db.produtos || []).forEach(prod => {
      const item = pedido.itens.find(i => i.id === prod.id);
      if (item) {
        prod.estoque -= item.quantidade;
        if (prod.estoque < 0) prod.estoque = 0;
      }
    });
  }

  // gera PIX
  try{
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
      value: Number(valor.toFixed(2))
    });

    pedido.pix = {
      payload: qrCodePix.payload().replace(/\s+/g, ""),
      qrCodeImage: await qrCodePix.base64(),
      txid,
      chave: chavePix
    };
  }catch(err){
    console.error("Erro ao gerar PIX do pedido:", err);
    pedido.pix = null;
  }

  db.pedidos.push(pedido);
  saveDB(db);

  // >>> Envia push para todos (funciona com app fechado / segundo plano)
  try {
    const nome = pedido?.cliente?.nome || "Cliente";
    await sendPushToAll(
      "Novo pedido!",
      `#${pedido.id} · ${nome} · R$ ${Number(pedido.total).toFixed(2).replace(".", ",")}`,
      { id: pedido.id }
    );
  } catch (e) {
    console.warn("[push] falhou ao enviar:", e?.message);
  }

  res.json(pedido);
});

app.put("/api/pedidos/:id/status", (req,res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  const pedido = (db.pedidos || []).find(p => p.id === id);
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
  pedido.status = req.body.status || pedido.status;
  saveDB(db);
  res.json(pedido);
});

app.delete("/api/pedidos/:id", (req,res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  db.pedidos = (db.pedidos || []).filter(p => p.id !== id);
  saveDB(db);
  res.json({ success:true });
});

// ---------------- Start ----------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
