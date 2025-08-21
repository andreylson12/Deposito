const express = require("express");
const fs = require("fs");
const path = require("path");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const DB_FILE = path.join(__dirname, "db.json");

// Funções auxiliares
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

// Deletar produto
app.delete("/api/produtos/:id", (req, res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  db.produtos = db.produtos.filter(p => p.id !== id);
  saveDB(db);
  res.json({ success: true });
});

// =================== ROTAS PEDIDOS ===================
// Listar todos
app.get("/api/pedidos", (req, res) => {
  const db = loadDB();
  res.json(db.pedidos);
});

// Consultar por ID
app.get("/api/pedidos/:id", (req, res) => {
  const db = loadDB();
  const id = parseInt(req.params.id);
  const pedido = db.pedidos.find(p => p.id === id);
  if (!pedido) {
    return res.status(404).json({ error: "Pedido não encontrado" });
  }
  res.json(pedido);
});

// Criar pedido
app.post("/api/pedidos", (req, res) => {
  const db = loadDB();
  const pedido = req.body;
  pedido.id = Date.now();
  pedido.status = "Pendente";

  // Atualizar estoque
  pedido.itens.forEach(item => {
    const produto = db.produtos.find(p => p.id === item.id);
    if (produto) {
      produto.estoque -= item.quantidade;
      if (produto.estoque < 0) produto.estoque = 0;
    }
  });

  db.pedidos.push(pedido);
  saveDB(db);
  res.json(pedido);
});

// Atualizar status
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

// Deletar pedido
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
