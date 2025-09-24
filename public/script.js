// ===================== UTIL =====================
const R$ = (n) => (Number(n) || 0).toFixed(2).replace(".", ",");

// Estado em memória
let produtos = [];
let carrinho = []; // [{id, nome, preco, quantidade, imagem}]

// ===================== PRODUTOS =====================
async function carregarProdutos() {
  try {
    const res = await fetch("/api/produtos", { cache: "no-store" });
    produtos = await res.json();
    renderProdutos(produtos);
  } catch (e) {
    console.error("Falha ao carregar produtos:", e);
  }
}

function renderProdutos(lista) {
  const grid = document.querySelector("#produtos-grid");
  if (!grid) return;
  grid.innerHTML = lista.map(p => `
    <div class="card" style="width:240px; padding:12px; border:1px solid #ddd; border-radius:8px; box-shadow: 0 1px 3px rgba(0,0,0,.06); margin:8px;">
      <img src="${p.imagem || 'https://via.placeholder.com/240x160?text=Produto'}" alt="${p.nome}" style="width:100%; height:160px; object-fit:cover; border-radius:6px;">
      <h4 style="margin:8px 0 4px">${p.nome}</h4>
      <div style="color:#333;">R$ ${R$(p.preco)}</div>
      <div style="color:#666; font-size:12px;">Estoque: ${Number(p.estoque) || 0}</div>
      <button class="btn-add" data-id="${String(p.id)}" style="margin-top:8px; background:#28a745; color:#fff; border:0; padding:8px 10px; border-radius:6px; cursor:pointer;">Adicionar</button>
    </div>
  `).join("");
}

// Delegação para botões "Adicionar"
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn-add");
  if (!btn) return;
  const id = String(btn.dataset.id);
  const p = produtos.find(x => String(x.id) === id);
  if (!p) return;
  adicionarAoCarrinho(p);
});

// ===================== CARRINHO =====================
function adicionarAoCarrinho(p) {
  const idx = carrinho.findIndex(i => String(i.id) === String(p.id));
  if (idx === -1) {
    carrinho.push({ id: String(p.id), nome: p.nome, preco: Number(p.preco)||0, quantidade: 1, imagem: p.imagem || "" });
  } else {
    carrinho[idx].quantidade += 1;
  }
  renderCarrinho();
}

function alterarQtd(id, delta) {
  const it = carrinho.find(i => String(i.id) === String(id));
  if (!it) return;
  it.quantidade = Math.max(1, (it.quantidade || 1) + delta);
  renderCarrinho();
}
function removerDoCarrinho(id) {
  carrinho = carrinho.filter(i => String(i.id) !== String(id));
  renderCarrinho();
}
function totalCarrinho() {
  return carrinho.reduce((acc, i) => acc + (Number(i.preco) * Number(i.quantidade)), 0);
}

function renderCarrinho() {
  const tbody = document.querySelector("#carrinho-body");
  const totalEl = document.querySelector("#carrinho-total");
  if (!tbody) return;

  tbody.innerHTML = carrinho.map(i => `
    <tr>
      <td>${i.nome}</td>
      <td>
        <button class="btn-qtd" data-id="${i.id}" data-delta="-1" title="Diminuir">−</button>
        <span style="margin:0 6px">${i.quantidade}</span>
        <button class="btn-qtd" data-id="${i.id}" data-delta="1" title="Aumentar">+</button>
      </td>
      <td>R$ ${R$(i.preco)}</td>
      <td>R$ ${R$(i.preco * i.quantidade)}</td>
      <td><button class="btn-remover" data-id="${i.id}" title="Remover">x</button></td>
    </tr>
  `).join("");

  if (totalEl) totalEl.textContent = "R$ " + R$(totalCarrinho());
}

// Delegação para +/− e remover
document.addEventListener("click", (e) => {
  const q = e.target.closest(".btn-qtd");
  if (q) {
    alterarQtd(q.dataset.id, Number(q.dataset.delta));
    return;
  }
  const r = e.target.closest(".btn-remover");
  if (r) {
    removerDoCarrinho(r.dataset.id);
  }
});

// ===================== FINALIZAR PEDIDO =====================
async function finalizarPedido() {
  if (!carrinho.length) {
    alert("Seu carrinho está vazio.");
    return;
  }

  // Coleta dados básicos do cliente se existirem inputs na página
  const nomeEl = document.querySelector("#cliente-nome");
  const endEl  = document.querySelector("#cliente-endereco");
  const telEl  = document.querySelector("#cliente-telefone");

  const cliente = {
    nome: nomeEl?.value || "Cliente",
    endereco: endEl?.value || "",
    telefone: telEl?.value || ""
  };

  const itens = carrinho.map(i => ({ id: i.id, nome: i.nome, quantidade: i.quantidade, preco: i.preco }));
  const total = totalCarrinho();

  try {
    const res = await fetch("/api/pedidos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cliente, itens, total })
    });
    const pedido = await res.json();

    // Exibe PIX se tiver elementos para isso
    const img = document.querySelector("#pix-img");
    const payload = document.querySelector("#pix-payload");
    if (pedido?.pix) {
      if (img && pedido.pix.qrCodeImage) img.src = pedido.pix.qrCodeImage;
      if (payload && pedido.pix.payload) payload.value = pedido.pix.payload;
      alert("Pedido criado! PIX gerado.");
    } else {
      alert("Pedido criado! (sem PIX)");
    }

    // limpa carrinho
    carrinho = [];
    renderCarrinho();
  } catch (e) {
    console.error("Falha ao finalizar pedido:", e);
    alert("Não foi possível finalizar o pedido. Tente novamente.");
  }
}

// Botão finalizar (se existir)
document.addEventListener("click", (e) => {
  if (e.target && e.target.id === "btn-finalizar") {
    finalizarPedido();
  }
});

// ===================== BOOT =====================
window.addEventListener("DOMContentLoaded", () => {
  // Se você ainda usa alguma lista simples em outra página, pode reaproveitar suas funções genéricas,
  // mas na delivery focamos só em produtos/carrinho/pedido.
  carregarProdutos().then(renderCarrinho);
});
