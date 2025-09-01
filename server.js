// servidor.js (ajustado)
const express = require("express");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const { QrCodePix } = require("qrcode-pix");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// --------- MIDDLEWARES ---------
app.use(express.json());

// ATENÇÃO: sua pasta no repo é "público" (com acento)
app.use(express.static(path.join(__dirname, "público")));

// CORS (ajuste a origin se tiver outro domínio de front)
app.use(cors({
  origin: true,
  methods: ["GET","POST","PUT","DELETE","OPTIONS"],
  credentials: true
}));

// Healthcheck para testar no navegador
app.get("/health", (_req, res) => res.json({ ok: true }));

const DB_FILE = path.join(__dirname, "db.json");

// =================== CONFIGURAÇÃO PIX ===================
const chavePix = "99 991842200";        // telefone
const nomeLoja = "ANDREYLSON SODRE";   // até 25 caracteres
const cidade   = "SAMBAIBA";           // até 15 caracteres, sem acento

// =================== FUNÇÕES AUXILIARES ===================
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ produtos: [], pedidos: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// =================== ROTAS ===================

// Chave PIX
app.get("/api/chave-pix", (_req, res) => {
  res.json({ chave: chavePix, nome: nomeLoja, cidade });
});

// Produtos
app.get("/api/produtos", (_req, res) => {
  const db = loadDB();
  res.json(db.produtos);
});
app.post("/api/produtos", (req, res) => {
  const db = loadDB();
  const novo = { ...req.body, id: Date.now() };
  db.produtos.push(novo);
  saveDB(db);
  res.json(novo);
});
app.delete("/api/produtos/:id", (req, res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  db.produtos = db.produtos.filter(p => p.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// PIX com valor e TXID
app.get("/api/pix/:valor/:txid?", async (req, res) => {
  try {
    const raw = String(req.params.valor).replace(",", ".");
    const valor = Number(raw);
    if (!Number.isFinite(valor) || valor < 0.01) {
      return res.status(400).json({ error: "Valor inválido (mínimo 0,01)" });
    }
    const txid = (req.params.txid || ("PIX" + Date.now())).slice(0, 25);

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
  } catch (err) {
    console.error("Erro ao gerar PIX:", err);
    res.status(500).json({ error: "Falha ao gerar QR Code PIX" });
  }
});

// ===== Pedidos (handlers reaproveitáveis para criar alias /pedidos) =====
function listPedidosHandler(_req, res) {
  const db = loadDB();
  res.json(db.pedidos);
}
function getPedidoHandler(req, res) {
  const db = loadDB();
  const id = parseInt(req.params.id);
  const pedido = db.pedidos.find(p => p.id === id);
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
  res.json(pedido);
}
async function createPedidoHandler(req, res) {
  const db = loadDB();
  const pedido = { ...req.body, id: Date.now(), status: "Pendente" };

  if (Array.isArray(pedido.itens)) {
    pedido.itens.forEach(item => {
      const produto = db.produtos.find(p => p.id === item.id);
      if (produto) {
        produto.estoque -= item.quantidade;
        if (produto.estoque < 0) produto.estoque = 0;
      }
    });
  }
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
      value: Number(valor.toFixed(2))
    });

    pedido.pix = {
      payload: qrCodePix.payload().replace(/\s+/g, ""),
      qrCodeImage: await qrCodePix.base64(),
      txid,
      chave: chavePix
    };
  } catch (err) {
    console.error("Erro ao gerar PIX do pedido:", err);
    pedido.pix = null;
  }

  db.pedidos.push(pedido);
  saveDB(db);
  res.json(pedido);
}
function updatePedidoStatusHandler(req, res) {
  const db = loadDB();
  const id = parseInt(req.params.id);
  const pedido = db.pedidos.find(p => p.id === id);
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
  pedido.status = req.body.status || pedido.status;
  saveDB(db);
  res.json(pedido);
}
function deletePedidoHandler(req, res) {
  const db = loadDB();
  const id = parseInt(req.params.id);
  db.pedidos = db.pedidos.filter(p => p.id !== id);
  saveDB(db);
  res.json({ success: true });
}

// Rotas oficiais da API
app.get("/api/pedidos", listPedidosHandler);
app.get("/api/pedidos/:id", getPedidoHandler);
app.post("/api/pedidos", createPedidoHandler);
app.put("/api/pedidos/:id/status", updatePedidoStatusHandler);
app.delete("/api/pedidos/:id", deletePedidoHandler);

// ALIASES para compatibilidade (/pedidos também funciona)
app.get("/pedidos", listPedidosHandler);
app.get("/pedidos/:id", getPedidoHandler);
app.post("/pedidos", createPedidoHandler);
app.put("/pedidos/:id/status", updatePedidoStatusHandler);
app.delete("/pedidos/:id", deletePedidoHandler);

// =================== INÍCIO DO SERVIDOR ===================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
