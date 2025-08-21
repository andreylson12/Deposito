let carrinho = [];

function moeda(n){ return Number(n).toFixed(2).replace('.', ','); }

// ---------------- PRODUTOS ----------------
async function carregarProdutos(){
  try {
    const res = await fetch("/api/produtos");
    const produtos = await res.json();
    const container = document.getElementById("listaProdutos");
    container.innerHTML = "";
    produtos.filter(p=>p.estoque>0).forEach(p=>{
      const div = document.createElement("div");
      div.className = "card";
      div.innerHTML = `
        <img src="${p.imagem}" alt="${p.nome}">
        <h3>${p.nome}</h3>
        <p>R$ ${moeda(p.preco)}</p>
        <p>Estoque: ${p.estoque}</p>
        <button onclick="adicionarCarrinho(${p.id}, '${p.nome}', ${p.preco})">Adicionar</button>
      `;
      container.appendChild(div);
    });
  } catch (err) {
    console.error("Erro ao carregar produtos:", err);
  }
}

// ---------------- CARRINHO ----------------
function adicionarCarrinho(id, nome, preco){
  const item = carrinho.find(i=>i.id===id);
  if(item){
    item.quantidade++;
  } else {
    carrinho.push({id, nome, preco, quantidade:1});
  }
  renderCarrinho();
}

function alterarQuantidade(id, delta){
  const item = carrinho.find(i=>i.id===id);
  if(item){
    item.quantidade += delta;
    if(item.quantidade <= 0){
      carrinho = carrinho.filter(i=>i.id!==id);
    }
  }
  renderCarrinho();
}

function removerItem(id){
  carrinho = carrinho.filter(i=>i.id!==id);
  renderCarrinho();
}

function renderCarrinho(){
  const tbody = document.getElementById("itensCarrinho");
  tbody.innerHTML = "";
  let total = 0;
  carrinho.forEach(i=>{
    const subtotal = i.preco * i.quantidade;
    total += subtotal;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${i.nome}</td>
      <td>${i.quantidade}</td>
      <td>R$ ${moeda(i.preco)}</td>
      <td>R$ ${moeda(subtotal)}</td>
      <td>
        <button class="btn btn-mais" onclick="alterarQuantidade(${i.id},1)">+</button>
        <button class="btn btn-menos" onclick="alterarQuantidade(${i.id},-1)">-</button>
        <button class="btn btn-remover" onclick="removerItem(${i.id})">x</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById("totalCarrinho").textContent = "Total: R$ " + moeda(total);
}

// ---------------- PEDIDO ----------------
async function finalizarPedido(){
  if(carrinho.length===0){ return alert("Carrinho vazio!"); }
  const nome = document.getElementById("nomeCliente").value;
  const endereco = document.getElementById("enderecoCliente").value;
  const pagamento = document.getElementById("pagamentoCliente").value;
  if(!nome || !endereco){ return alert("Preencha nome e endereço!"); }

  const total = carrinho.reduce((s,i)=>s+i.preco*i.quantidade,0);
  const pedido = { nome, endereco, pagamento, itens: carrinho, total };

  try {
    const res = await fetch("/api/pedidos", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify(pedido)
    });
    if(res.ok){
      const salvo = await res.json();
      alert("Pedido realizado com sucesso! ID do pedido: " + salvo.id);
      if(pagamento === "PIX"){
        gerarPix(total);
      }
      carrinho = [];
      renderCarrinho();
    } else {
      alert("Erro ao enviar pedido");
    }
  } catch (err) {
    console.error("Erro ao finalizar pedido:", err);
    alert("Falha na conexão com o servidor.");
  }
}

// ---------------- PIX ----------------
async function gerarPix(total){
  try {
    const qrRes = await fetch(`/api/pix/${total}`);
    const { qr, payload } = await qrRes.json();
    document.getElementById("pixQr").src = qr;
    document.getElementById("pixCodigo").value = payload;
    document.getElementById("pagamento").style.display = "block";
  } catch (err) {
    console.error("Erro ao gerar PIX:", err);
  }
}

function copiarPix(){
  const input = document.getElementById("pixCodigo");
  input.select();
  input.setSelectionRange(0, 99999);
  document.execCommand("copy");
  alert("Código PIX copiado!");
}

// ---------------- STATUS ----------------
async function consultarStatus(){
  const id = document.getElementById("pedidoIdInput").value;
  if(!id) return alert("Informe o ID do pedido");
  try {
    const res = await fetch("/api/pedidos/"+id);
    if(res.ok){
      const pedido = await res.json();
      document.getElementById("resultadoStatus").textContent =
        "Status: " + pedido.status + " | Total: R$ " + moeda(pedido.total);
    } else {
      document.getElementById("resultadoStatus").textContent = "Pedido não encontrado.";
    }
  } catch (err) {
    console.error("Erro ao consultar status:", err);
    document.getElementById("resultadoStatus").textContent = "Erro na consulta.";
  }
}

// ---------------- INIT ----------------
document.addEventListener("DOMContentLoaded", carregarProdutos);
