const express = require("express");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");           // (não é usado diretamente, mas pode deixar)
const { QrCodePix } = require("qrcode-pix");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DB_FILE = path.join(__dirname, "db.json");

// =================== CONFIGURAÇÃO PIX ===================
// Use UMA chave válida: CPF sem pontos/traço OU sua chave aleatória real.
// Se quiser usar CPF: const chavePix = "61144602351";
const chavePix = "99 991842200";  // telefone
const nomeLoja = "ANDREYLSON SODRE";                      // máx 25 caracteres
const cidade   = "SAMBAIBA";                              // máx 15 caracteres, sem acento

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

// =================== ROTAS PRODUTOS ===================
app.get("/api/produtos", (req, res) => {
  const db = loadDB();
  res.json(db.produtos);
});

app.post("/api/produtos", (req, res) => {
  const db = loadDB();
  const novo = req.body;
  novo.id = Date.now();
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

// =================== ROTA PIX (GERAÇÃO DIRETA) ===================
app.get("/api/pix/:valor/:txid?", async (req, res) => {
  try {
    // aceita "10,50" ou "10.50"
    const raw = String(req.params.valor).replace(",", ".");
    const valor = Number(raw);

    if (!Number.isFinite(valor) || valor < 0.01) {
      return res.status(400).json({ error: "Valor inválido (mínimo 0,01)" });
    }

    // txid até 25 caracteres (regra do BACEN)
    const txid = (req.params.txid || ("ADEGA" + Date.now())).slice(0, 25);

    const qrCodePix = QrCodePix({
      version: "01",
      key: chavePix,
      name: nomeLoja,
      city: cidade,
      transactionId: txid,
      value: Number(valor.toFixed(2))
    });

    // payload SEM espaços/linhas
    const payload = qrCodePix.payload().replace(/\s+/g, "");
    const qrCodeImage = await qrCodePix.base64();

    res.set("Cache-Control", "no-store");
    res.json({ payload, qrCodeImage, txid });
  } catch (err) {
    console.error("Erro ao gerar PIX:", err);
    res.status(500).json({ error: "Falha ao gerar QR Code PIX" });
  }
});

// =================== ROTAS PEDIDOS ===================
app.get("/api/pedidos", (req, res) => {
  const db = loadDB();
  res.json(db.pedidos);
});

app.get("/api/pedidos/:id", (req, res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  const pedido = db.pedidos.find(p => p.id === id);
  if (!pedido) {
    return res.status(404).json({ error: "Pedido não encontrado" });
  }
  res.json(pedido);
});

app.post("/api/pedidos", async (req, res) => {
  const db = loadDB();
  const pedido = req.body;
  pedido.id = Date.now();
  pedido.status = "Pendente";

  // Atualizar estoque (se houver itens)
  if (Array.isArray(pedido.itens)) {
    pedido.itens.forEach(item => {
      const produto = db.produtos.find(p => p.id === item.id);
      if (produto) {
        produto.estoque -= item.quantidade;
        if (produto.estoque < 0) produto.estoque = 0;
      }
    });
  }

  // Gera PIX junto com o pedido
  try {
    // aceita "10,50" vindo do front
    const rawTotal = String(pedido.total).replace(",", ".");
    const valor = Number(rawTotal);

    if (!Number.isFinite(valor) || valor < 0.01) {
      throw new Error("Valor do pedido inválido para PIX");
    }

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
      txid
    };
  } catch (err) {
    console.error("Erro ao gerar PIX do pedido:", err);
    pedido.pix = null; // mantém o pedido, mas sem PIX gerado
  }

  db.pedidos.push(pedido);
  saveDB(db);
  res.json(pedido);
});

app.put("/api/pedidos/:id/status", (req, res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  const pedido = db.pedidos.find(p => p.id === id);
  if (!pedido) {
    return res.status(404).json({ error: "Pedido não encontrado" });
  }
  pedido.status = req.body.status || pedido.status;
  saveDB(db);
  res.json(pedido);
});

app.delete("/api/pedidos/:id", (req, res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  db.pedidos = db.pedidos.filter(p => p.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// =================== START SERVER ===================
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});

