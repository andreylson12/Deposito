// Função genérica para enviar dados
async function enviarFormulario(formId, rota, listaId) {
  const form = document.getElementById(formId);
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const dados = Object.fromEntries(new FormData(form).entries());
    await fetch(`/api/${rota}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(dados),
    });
    form.reset();
    carregarLista(rota, listaId);
  });
}

// Função genérica para carregar listas
async function carregarLista(rota, listaId) {
  const res = await fetch(`/api/${rota}`);
  const dados = await res.json();
  const lista = document.getElementById(listaId);
  lista.innerHTML = "";
  dados.forEach(item => {
    lista.innerHTML += `<li>${JSON.stringify(item)}</li>`;
  });
}

// Inicializar
window.onload = () => {
  enviarFormulario("form-produto", "produtos", "lista-produtos");
  enviarFormulario("form-cliente", "clientes", "lista-clientes");
  enviarFormulario("form-venda", "vendas", "lista-vendas");
  enviarFormulario("form-estoque", "estoque", "lista-estoque");

  carregarLista("produtos", "lista-produtos");
  carregarLista("clientes", "lista-clientes");
  carregarLista("vendas", "lista-vendas");
  carregarLista("estoque", "lista-estoque");
};
