// server.js – estável para Railway
const express = require("express");
const fs = require("fs");
const path = require("path");
const { QrCodePix } = require("qrcode-pix");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(express.json());
app.use(cors({ origin: true, methods: ["GET","POST","PUT","DELETE","OPTIONS"], credentials: true }));

// Arquivos estáticos
app.use(express.static(path.join(__dirname, "public")));

// Rotas explícitas (garantem abertura das páginas)
app.get(["/","/index","/index.html"], (_req,res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.get(["/delivery","/delivery.html"], (_req,res) => {
  res.sendFile(path.join(__dirname, "public", "delivery.html"));
});

// Healthcheck
app.get("/health", (_req,res) => res.json({ ok:true }));

// “Banco” em arquivo
const DB_FILE = path.join(__dirname, "db.json");
function loadDB(){
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ produtos: [], pedidos: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE));
}
function saveDB(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

// Configuração PIX (ajuste seus dados)
const chavePix = "99 991842200";
const nomeLoja = "ANDREYLSON SODRE";
const cidade   = "SAMBAIBA";

// API
app.get("/api/chave-pix", (_req,res) => {
  res.json({ chave: chavePix, nome: nomeLoja, cidade });
});

app.get("/api/produtos", (_req,res) => {
  const db = loadDB(); res.json(db.produtos);
});

app.post("/api/produtos", (req,res) => {
  const db = loadDB();
  const novo = { ...req.body, id: Date.now() };
  db.produtos.push(novo); saveDB(db);
  res.json(novo);
});

app.delete("/api/produtos/:id", (req,res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  db.produtos = db.produtos.filter(p => p.id !== id);
  saveDB(db); res.json({ success:true });
});

// PIX com valor e TXID
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

// Pedidos
app.get("/api/pedidos", (_req,res) => {
  const db = loadDB(); res.json(db.pedidos);
});

app.get("/api/pedidos/:id", (req,res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  const pedido = db.pedidos.find(p => p.id === id);
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
  res.json(pedido);
});

app.post("/api/pedidos", async (req,res) => {
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

  db.pedidos.push(pedido); saveDB(db);
  res.json(pedido);
});

app.put("/api/pedidos/:id/status", (req,res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  const pedido = db.pedidos.find(p => p.id === id);
  if (!pedido) return res.status(404).json({ error: "Pedido não encontrado" });
  pedido.status = req.body.status || pedido.status;
  saveDB(db); res.json(pedido);
});

app.delete("/api/pedidos/:id", (req,res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  db.pedidos = db.pedidos.filter(p => p.id !== id);
  saveDB(db); res.json({ success:true });
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
