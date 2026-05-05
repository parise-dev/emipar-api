// server.js

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const db = require("./firebase");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
require("dotenv").config();
const asaas = require("./asaasClient");

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

const whatsappRoutes = require("./routes/whatsapp");
app.use("/whatsapp", whatsappRoutes);

// --- Função JWT ---
const generateToken = (email) =>
  jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: "1h" });

// --- Função vendedor atual ---
async function getSellerAtual() {
  const ref = db.collection("configuracoes").doc("vendedor_atual");
  const doc = await ref.get();
  if (!doc.exists) return "";
  return doc.data().seller || "";
}

// ==============================
// 🕒 RANGE "HOJE" NO FUSO BR (SP)
// ==============================
function tzParts(timeZone, date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = dtf.formatToParts(date);
  const out = {};
  for (const p of parts) out[p.type] = p.value;
  return out;
}

function tzOffsetMinutes(timeZone, date) {
  const p = tzParts(timeZone, date);
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second)
  );
  return (asUTC - date.getTime()) / 60000;
}

// retorna ISO do início do dia em SP (convertido pra UTC ISO, que é o que você salva)
function startOfDayISO_SP(dateObj) {
  const tz = "America/Sao_Paulo";
  const p = tzParts(tz, dateObj);

  const approx = new Date(
    Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 0, 0, 0, 0)
  );
  const offMin = tzOffsetMinutes(tz, approx);

  return new Date(approx.getTime() - offMin * 60000).toISOString();
}

// retorna ISO do fim do dia em SP (convertido pra UTC ISO)
function endOfDayISO_SP(dateObj) {
  const tz = "America/Sao_Paulo";
  const p = tzParts(tz, dateObj);

  const approx = new Date(
    Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      23,
      59,
      59,
      999
    )
  );
  const offMin = tzOffsetMinutes(tz, approx);

  return new Date(approx.getTime() - offMin * 60000).toISOString();
}

function formatDateKeySP(dateObj) {
  const tz = "America/Sao_Paulo";
  const p = tzParts(tz, dateObj);
  return `${p.year}-${p.month}-${p.day}`;
}

function normalizeString(v) {
  return String(v || "").trim();
}
function safeNumber(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}
function safeInt(v, def = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}


// ==============================
// ✅ CORTE DO SISTEMA (OPÇÃO A)
// Tudo do Dashboard/Financeiro considera só dados a partir daqui
// ==============================
const SYSTEM_START_ISO = process.env.SYSTEM_START_ISO || "2026-01-15T00:00:00.000Z";

function clampInicioRange(inicioISO) {
  // garante que qualquer consulta nunca pegue antes do SYSTEM_START_ISO
  try {
    const ini = new Date(inicioISO).toISOString();
    const start = new Date(SYSTEM_START_ISO).toISOString();
    return ini < start ? start : ini;
  } catch {
    return SYSTEM_START_ISO;
  }
}


// Suporta filtro que venha como "YYYY-MM-DD"
function normalizeRangeISO(inicio, fim) {
  if (!inicio || !fim) return { inicio: null, fim: null };

  const isDateOnly = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s));

  // OBS: aqui deixei como Z (UTC) porque é filtro genérico.
  // Se quiser, depois fazemos uma versão SP também para relatórios.
  if (isDateOnly(inicio) && isDateOnly(fim)) {
    const di = new Date(`${inicio}T00:00:00.000Z`).toISOString();
    const df = new Date(`${fim}T23:59:59.999Z`).toISOString();
    return { inicio: di, fim: df };
  }

  try {
    const di = new Date(inicio).toISOString();
    const df = new Date(fim).toISOString();
    return { inicio: di, fim: df };
  } catch {
    return { inicio: null, fim: null };
  }
}

// ==============================
// ✅ PADRÃO PAGAMENTO: Pago | Extravio | Devolucao | Não Pago
// Substatus do Extravio: Aberto | Pago | Não Pago
// ==============================
function normalizePagamento(status) {
  const s = normalizeString(status);
  if (!s) return "Pendente"; // ✅ default novo: pendente
  const low = s.toLowerCase();

  if (low === "pago") return "Pago";

  // ✅ PENDENTE passa a existir de verdade
  if (low === "pendente") return "Pendente";

  // PADRÃO NOVO: Extravio
  if (low === "extravio" || low === "extraviado") return "Extravio";

  if (low === "devolucao" || low === "devolução") return "Devolucao";

  if (
    low === "não pago" ||
    low === "nao pago" ||
    low === "nao-pago" ||
    low === "não-pago"
  ) return "Não Pago";

  return s;
}


function normalizeExtraviadoSubstatus(status) {
  const s = normalizeString(status);
  if (!s) return "Aberto";
  const low = s.toLowerCase();

  if (low === "aberto") return "Aberto";
  if (low === "pago") return "Pago";
  if (
    low === "não pago" ||
    low === "nao pago" ||
    low === "nao-pago" ||
    low === "não-pago"
  )
    return "Não Pago";

  return s;
}

// “Efetivamente pago” (para RECEBIDO)
// - Pago normal => pago
// - Extravio + substatus Pago => pago
// IMPORTANTE: status_envio não entra aqui.
function isEffectivePaid(obj) {
  const sp = normalizePagamento(obj?.status_pagamento);
  const se = normalizeExtraviadoSubstatus(obj?.status_extraviado);

  if (sp === "Pago") return true;
  if (sp === "Extravio" && se === "Pago") return true;

  return false;
}



function normalizeISODateInput_SP(input) {
  const s = String(input || "").trim();
  if (!s) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return new Date(`${s}T12:00:00.000-03:00`).toISOString();
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

function onlyDigits(v) {
  return String(v || "").replace(/\D/g, "");
}

function isValidCpfCnpj(v) {
  const d = onlyDigits(v);
  return d.length === 11 || d.length === 14;
}

function normalizePhoneBR(phone) {
  let digits = onlyDigits(phone);

  if (digits.startsWith("55") && digits.length > 11) {
    digits = digits.slice(2);
  }

  if (digits.length > 11) {
    digits = digits.slice(-11);
  }

  return digits;
}

function normalizeCpfCnpj(v) {
  return onlyDigits(v);
}

async function findClienteExistente({ phone, cpf, excludeId = null }) {
  const phoneNorm = normalizePhoneBR(phone);
  const cpfNorm = normalizeCpfCnpj(cpf);

  if (!phoneNorm && !cpfNorm) {
    return {
      exists: false,
      cliente: null,
      phoneNorm: "",
      cpfNorm: "",
      isCaloteiro: false,
      caloteMotivo: "",
    };
  }

  const snap = await db.collection("clientes").get();

  const matches = snap.docs
    .filter((doc) => {
      if (excludeId && doc.id === excludeId) return false;

      const c = doc.data();

      const phoneCliente = normalizePhoneBR(c.phone || "");
      const cpfCliente = normalizeCpfCnpj(c.cpf || "");

      return (
        (phoneNorm && phoneNorm === phoneCliente) ||
        (cpfNorm && cpfNorm === cpfCliente)
      );
    })
    .map((doc) => ({ id: doc.id, ...doc.data() }));

  const existente = matches[0] || null;

  const calote = matches.find((c) => {
    const pagamento = normalizePagamento(c.status_pagamento);
    const extraviado = normalizeExtraviadoSubstatus(c.status_extraviado);
    const envio = normalizeString(c.status_envio);

    return (
      pagamento === "Não Pago" ||
      pagamento === "Extravio" ||
      envio === "Extravio" ||
      envio === "Devolucao" ||
      extraviado === "Não Pago"
    );
  });

  return {
    exists: !!existente,
    cliente: existente,
    phoneNorm,
    cpfNorm,
    isCaloteiro: !!calote,
    caloteMotivo: calote
      ? `${calote.status_pagamento || ""} ${calote.status_envio || ""} ${calote.status_extraviado || ""}`.trim()
      : "",
  };
}

function ensureAsaasObj(cliente) {
  const a = cliente?.asaas || {};
  return {
    customerId: a.customerId || "",
    paymentId: a.paymentId || "",
    bankSlipUrl: a.bankSlipUrl || "",
    invoiceUrl: a.invoiceUrl || "",
    status: a.status || "",
    lastEvent: a.lastEvent || "",
    updatedAt: a.updatedAt || "",
  };
}


// ==============================
// 🔎 HELPERS ESTOQUE / GRUPO
// ==============================
async function getEstoqueById(id) {
  if (!id) return null;
  const ref = db.collection("estoque").doc(String(id));
  const doc = await ref.get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

async function calcularRankingGeral() {
  // 1) Pega TODOS os clientes (all-time) uma vez só
  const allSnap = await db.collection("clientes").get();
  const all = allSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // 2) Ignora cancelados do ranking (regra que você pediu)
  const ativos = all.filter(
    (c) => normalizeString(c.status_pedido) !== "Cancelado"
  );

  const ranking = {};

  // helper para garantir objeto
  function ensure(vendedor) {
    const v = vendedor || "Sem vendedor";
    if (!ranking[v]) {
      ranking[v] = {
        vendedor: v,

        // ✅ legado (seu front já usa)
        fechado: 0,
        concluido: 0,

        // ✅ novos
        clientes_recebidos: 0, // total de leads recebidos (all-time)
        vendidos_qtd: 0,       // qtd vendido (status atual)
        taxa_fechamento: 0,    // % vendido / recebidos
      };
    }
    return ranking[v];
  }

  // 3) Conta leads recebidos (all-time)
  for (const c of ativos) {
    const v = normalizeString(c.seller) || "Sem vendedor";
    const item = ensure(v);
    item.clientes_recebidos += 1;
  }

  // 4) Soma FECHADO (all-time) apenas status atual = Vendido
  for (const c of ativos) {
    if (normalizeString(c.status_pedido) !== "Vendido") continue;

    const v = normalizeString(c.seller) || "Sem vendedor";
    const item = ensure(v);

    item.vendidos_qtd += 1;
    item.fechado += safeNumber(c.valor_total);
  }

  // 5) Soma CONCLUÍDO (all-time) por Etiqueta Gerada
  for (const c of ativos) {
    if (normalizeString(c.status_envio) !== "Etiqueta Gerada") continue;

    const v = normalizeString(c.seller) || "Sem vendedor";
    const item = ensure(v);

    item.concluido += safeNumber(c.valor_total);
  }

  // 6) Calcula taxa de fechamento (%)
  for (const key of Object.keys(ranking)) {
    const r = ranking[key];
    const recebidos = safeInt(r.clientes_recebidos, 0);
    const vendidos = safeInt(r.vendidos_qtd, 0);

    r.taxa_fechamento = recebidos > 0 ? Number(((vendidos / recebidos) * 100).toFixed(1)) : 0;
  }

  // 7) Ordena por performance (fechado + concluido)
  return Object.values(ranking).sort(
    (a, b) => (b.fechado + b.concluido) - (a.fechado + a.concluido)
  );
}



async function getEstoqueByNome(nome) {
  const produto = normalizeString(nome);
  if (!produto) return null;

  const snap = await db
    .collection("estoque")
    .where("produto", "==", produto)
    .limit(1)
    .get();

  if (snap.empty) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}

async function getGrupoById(id) {
  if (!id) return null;
  const ref = db.collection("grupos_venda").doc(String(id));
  const doc = await ref.get();
  if (!doc.exists) return null;
  return { id: doc.id, ...doc.data() };
}

// Resolve produto quando o front mandar "produto" como ID do estoque.
// Mantém compat com legado que manda nome.
async function resolveProdutoFields(data) {
  if (data.produtoId) {
    const est = await getEstoqueById(data.produtoId);
    if (est) {
      return {
        produtoId: String(est.id),
        produto: est.produto || "",
      };
    }
  }

  if (data.produto) {
    const maybeId = String(data.produto);
    const est = await getEstoqueById(maybeId);
    if (est) {
      return {
        produtoId: String(est.id),
        produto: est.produto || "",
      };
    }

    return {
      produtoId: data.produtoId || "",
      produto: String(data.produto),
    };
  }

  return {
    produtoId: data.produtoId || "",
    produto: data.produto || "",
  };
}

// ==============================
// 🔐 USUÁRIOS
// ==============================
app.post("/register", async (req, res) => {
  const { email, password, nome } = req.body;
  try {
    const snapshot = await db
      .collection("users")
      .where("email", "==", email)
      .get();
    if (!snapshot.empty)
      return res.status(400).json({ error: "E-mail já registrado" });

    const hash = await bcrypt.hash(password, 10);
    const ref = await db.collection("users").add({
      email,
      password: hash,
      nome: nome || "",
    });

    res
      .status(201)
      .json({ message: "Usuário registrado com sucesso", userId: ref.id });
  } catch (e) {
    res.status(500).json({ error: "Erro ao registrar usuário" });
  }
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const snapshot = await db
      .collection("users")
      .where("email", "==", email)
      .get();
    if (snapshot.empty)
      return res.status(400).json({ error: "E-mail ou senha inválidos" });

    const userDoc = snapshot.docs[0];
    const user = userDoc.data();

    const match = await bcrypt.compare(password, user.password);
    if (!match)
      return res.status(400).json({ error: "E-mail ou senha inválidos" });

    const token = generateToken(user.email);

    res.status(200).json({
      message: "Login bem-sucedido",
      token,
      userId: userDoc.id,
      nome: user.nome || "",
    });
  } catch (e) {
    res.status(500).json({ error: "Erro ao fazer login", details: e.message });
  }
});

// ==============================
// 👤 VENDEDOR DO DIA
// ==============================
app.put("/configuracoes/vendedor", async (req, res) => {
  try {
    const { seller } = req.body;

    if (!seller) {
      return res.status(400).json({ error: "Nome do vendedor obrigatório" });
    }

    const ref = db.collection("configuracoes").doc("vendedor_atual");

    await ref.set({
      seller,
      atualizado_em: new Date().toISOString(),
    });

    res.status(200).json({
      message: "Vendedor do dia definido com sucesso",
      seller,
    });
  } catch (e) {
    res.status(500).json({ error: "Erro ao salvar vendedor atual" });
  }
});

app.get("/configuracoes/vendedor", async (req, res) => {
  try {
    const ref = db.collection("configuracoes").doc("vendedor_atual");
    const doc = await ref.get();

    if (!doc.exists) return res.json({ seller: null });

    res.json({ seller: doc.data().seller || null });
  } catch (error) {
    res.status(500).json({ error: "Erro ao buscar vendedor atual" });
  }
});

// ==============================
// 📦 GRUPOS DE VENDA
// ==============================
app.post("/grupos-venda", async (req, res) => {
  try {
    const { nome, preco_venda, itens } = req.body;

    if (!normalizeString(nome)) {
      return res.status(400).json({ error: "Nome do grupo obrigatório" });
    }
    if (!Array.isArray(itens) || itens.length === 0) {
      return res.status(400).json({ error: "Selecione ao menos 1 item" });
    }

    const normalizedItens = itens
      .map((x) => ({
        produtoId: String(x.produtoId || ""),
        quantidade: safeInt(x.quantidade || 0, 0),
      }))
      .filter((x) => x.produtoId && x.quantidade > 0);

    if (!normalizedItens.length) {
      return res.status(400).json({ error: "Itens inválidos" });
    }

    const docRef = await db.collection("grupos_venda").add({
      nome: normalizeString(nome),
      preco_venda: safeNumber(preco_venda),
      itens: normalizedItens,
      atualizado_em: new Date().toISOString(),
      criado_em: new Date().toISOString(),
    });

    res.status(201).json({ id: docRef.id, ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao criar grupo" });
  }
});

app.get("/grupos-venda", async (req, res) => {
  try {
    const snap = await db.collection("grupos_venda").orderBy("nome", "asc").get();
    const gruposRaw = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    const estoqueSnap = await db.collection("estoque").get();
    const estoqueMap = new Map();
    estoqueSnap.docs.forEach((d) =>
      estoqueMap.set(d.id, { id: d.id, ...d.data() })
    );

    const grupos = gruposRaw.map((g) => ({
      ...g,
      itens: Array.isArray(g.itens)
        ? g.itens.map((it) => {
            const est = estoqueMap.get(String(it.produtoId));
            return {
              produtoId: String(it.produtoId),
              quantidade: safeInt(it.quantidade || 0, 0),
              produto: est?.produto || "",
              custo_unitario: safeNumber(est?.custo_unitario || 0),
            };
          })
        : [],
    }));

    res.json(grupos);
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao carregar grupos" });
  }
});

app.put("/grupos-venda/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const ref = db.collection("grupos_venda").doc(id);
    const doc = await ref.get();
    if (!doc.exists)
      return res.status(404).json({ error: "Grupo não encontrado" });

    const { nome, preco_venda, itens } = req.body;

    const payload = { atualizado_em: new Date().toISOString() };

    if (nome != null) payload.nome = normalizeString(nome);
    if (preco_venda != null) payload.preco_venda = safeNumber(preco_venda);

    if (itens != null) {
      if (!Array.isArray(itens) || itens.length === 0) {
        return res.status(400).json({ error: "Itens obrigatórios" });
      }
      const normalizedItens = itens
        .map((x) => ({
          produtoId: String(x.produtoId || ""),
          quantidade: safeInt(x.quantidade || 0, 0),
        }))
        .filter((x) => x.produtoId && x.quantidade > 0);

      if (!normalizedItens.length) {
        return res.status(400).json({ error: "Itens inválidos" });
      }
      payload.itens = normalizedItens;
    }

    await ref.update(payload);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao atualizar grupo" });
  }
});

app.delete("/grupos-venda/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const ref = db.collection("grupos_venda").doc(id);
    const doc = await ref.get();
    if (!doc.exists)
      return res.status(404).json({ error: "Grupo não encontrado" });

    await ref.delete();
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message || "Erro ao deletar grupo" });
  }
});

// ==============================
// 👥 CLIENTES
// ==============================
app.post("/clientes", async (req, res) => {
  try {
    const data = req.body;
    const origem = (data.origem || "Checkout").trim();

    const resolvedProduto = await resolveProdutoFields(data);
    const grupoId = data.grupoId ? String(data.grupoId) : "";

    const phoneRaw =
      origem.toLowerCase() === "typebot"
        ? (data.telefone || "")
        : (data.phone || "");

    const cpfRaw = data.cpf || "";

    const checkCliente = await findClienteExistente({
      phone: phoneRaw,
      cpf: cpfRaw,
    });

    // 🟢 TYPEBOT
    if (origem.toLowerCase() === "typebot") {
      const quantidade = Number(data.quantidade || 1);

      const sellerAtual = await getSellerAtual();
      if (!sellerAtual) {
        return res.status(400).json({ error: "Nenhum vendedor configurado no sistema" });
      }

      let valorTotalFinal = safeNumber(data.valor_total);
      let produtoFinal = resolvedProduto.produto || data.produto || "";
      let produtoIdFinal = resolvedProduto.produtoId || "";
      let grupoFinalId = grupoId || "";

      if (grupoFinalId) {
        const grupo = await getGrupoById(grupoFinalId);

        if (!grupo) {
          return res.status(400).json({ error: "Grupo de venda não encontrado" });
        }

        const precoVendaGrupo = safeNumber(grupo.preco_venda);
        valorTotalFinal = precoVendaGrupo * quantidade;
        produtoFinal = normalizeString(grupo.nome) || produtoFinal || "Grupo";
      }

      if (!Number.isFinite(valorTotalFinal) || valorTotalFinal <= 0) {
        valorTotalFinal = 49 * quantidade;
      }

      const clienteTypebot = {
        nome: data.nome || "",
        cpf: "",
        phone: data.telefone || "",
        phone_normalizado: checkCliente.phoneNorm,
        cpf_cnpj_normalizado: checkCliente.cpfNorm,
        ja_e_cliente: checkCliente.exists,
        cliente_existente_id: checkCliente.cliente?.id || "",
        data_criacao: new Date().toISOString(),

        produtoId: produtoIdFinal,
        produto: produtoFinal,
        grupoId: grupoFinalId,

        quantidade,
        valor_total: valorTotalFinal,
        valor_frete: 0,

        status_pedido: "Aberto",
        status_pagamento: "Pendente",
        status_extraviado: "",
        status_envio: "Ag. Envio",

        data_venda: "",

        observacao: data.obs || "",
        data_entrega: "",
        origem: "Typebot",

        endereco: {
          cep: data.cep || "",
          logradouro: data.logradouro || "",
          numero: data.nCasa || "",
          bairro: data.bairro || "",
          complemento: "",
          localidade: data.localidade || "",
          estado: data.estado || "",
          uf: data.uf || "",
          obs: data.obs || "",
        },

        seller: sellerAtual,

        estoque_debitado: false,
        financeiro_frete_id: "",
        financeiro_entrada_id: "",
        data_pagamento: "",

        codigo_rastreio: "",
        valor_envio: 0,
        data_envio: "",
        rastreiozap_gerado: false,
        rastreiozap_gerado_em: "",
        rastreiozap_order_id: "",
        email: data.email || ""
      };

      const ref = await db.collection("clientes").add(clienteTypebot);
      return res.status(201).json({
        message: "Cliente (Typebot) criado com sucesso",
        id: ref.id,
        ja_e_cliente: checkCliente.exists,
        cliente_existente_id: checkCliente.cliente?.id || null,
        sinalizacao_cliente: checkCliente.isCaloteiro ? "calote" : "",
calote_motivo: checkCliente.caloteMotivo || "",
        data: clienteTypebot,
      });
    }

    // 🟡 CHECKOUT
    const quantidadeCheckout = Number(data.quantidade || 1);

    let valorTotalCheckout = safeNumber(data.valor_total || 0);
    let valorFreteCheckout = safeNumber(data.valor_frete || 0);

    let produtoCheckout = resolvedProduto.produto || "";
    let produtoIdCheckout = resolvedProduto.produtoId || "";
    let grupoCheckoutId = grupoId || "";

    if (grupoCheckoutId) {
      const grupo = await getGrupoById(grupoCheckoutId);

      if (!grupo) {
        return res.status(400).json({ error: "Grupo de venda não encontrado" });
      }

      const precoVendaGrupo = safeNumber(grupo.preco_venda);
      valorTotalCheckout = precoVendaGrupo * quantidadeCheckout;
      produtoCheckout = normalizeString(grupo.nome) || produtoCheckout || "Grupo";
    }

    if (!Number.isFinite(valorTotalCheckout) || valorTotalCheckout <= 0) {
      valorTotalCheckout = 49 * quantidadeCheckout;
    }
    
    const clienteCheckout = {
      nome: data.nome || "",
      cpf: data.cpf || "",
      phone: data.phone || "",
      phone_normalizado: checkCliente.phoneNorm,
      cpf_cnpj_normalizado: checkCliente.cpfNorm,
      ja_e_cliente: checkCliente.exists,
      cliente_existente_id: checkCliente.cliente?.id || "",
      data_criacao: data.data_criacao || new Date().toISOString(),

      produtoId: produtoIdCheckout || "",
      produto: produtoCheckout || "",
      grupoId: grupoCheckoutId || "",

      quantidade: quantidadeCheckout,
      valor_total: valorTotalCheckout,
      valor_frete: valorFreteCheckout,

      status_pedido: data.status_pedido || "Aberto",
      status_pagamento: normalizePagamento(data.status_pagamento || "Não Pago"),
      status_extraviado: "",
      status_envio: data.status_envio || "Ag. Envio",

      data_venda: "",

      codigo_rastreio: "",
      valor_envio: 0,
      data_envio: "",

      observacao: data.observacao || "",
      data_entrega: data.data_entrega || "",
      origem: "Checkout",

      endereco: {
        cep: data.endereco?.cep || "",
        logradouro: data.endereco?.logradouro || "",
        numero: data.endereco?.numero || "",
        complemento: data.endereco?.complemento || "",
        bairro: data.endereco?.bairro || "",
        localidade: data.endereco?.localidade || "",
        estado: data.endereco?.estado || "",
        uf: data.endereco?.uf || "",
        obs: data.endereco?.obs || "",
      },

      estoque_debitado: false,
      financeiro_frete_id: "",
      financeiro_entrada_id: "",
      data_pagamento: "",
      rastreiozap_gerado: false,
      rastreiozap_gerado_em: "",
      rastreiozap_order_id: "",
      email: data.email || "",
      cliente_existente_id: checkCliente.cliente?.id || "",
      sinalizacao_cliente: checkCliente.isCaloteiro ? "calote" : "",
calote_motivo: checkCliente.caloteMotivo || "",
    };

    const ref = await db.collection("clientes").add(clienteCheckout);
    res.status(201).json({
      message: "Cliente (Checkout) criado com sucesso",
      id: ref.id,
      ja_e_cliente: checkCliente.exists,
      cliente_existente_id: checkCliente.cliente?.id || null,
      data: clienteCheckout,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


app.get("/clientes", async (_, res) => {
  try {
    const snap = await db
      .collection("clientes")
      .orderBy("data_criacao", "desc")
      .get();
    const clientes = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(clientes);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/clientes/busca", async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.json([]);

    const termo = String(q).toLowerCase();

    const snap = await db.collection("clientes").get();
    const clientes = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    const pickEnderecoText = (c) => {
      const e = c.endereco || {};
      return [
        e.cep,
        e.logradouro,
        e.numero,
        e.complemento,
        e.bairro,
        e.localidade,
        e.estado,
        e.uf,
        e.obs,
        c.cep,
        c.logradouro,
        c.numero,
        c.bairro,
        c.uf,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    };

    const filtrados = clientes.filter((c) => {
      const nome = (c.nome || "").toLowerCase();
      const phone = (c.phone || "").toLowerCase();
      const seller = (c.seller || "").toLowerCase();
      const produto = (c.produto || "").toLowerCase();
      const produtoId = (c.produtoId || "").toLowerCase();
      const grupoId = (c.grupoId || "").toLowerCase();
      const endTxt = pickEnderecoText(c);

      return (
        nome.includes(termo) ||
        phone.includes(termo) ||
        seller.includes(termo) ||
        produto.includes(termo) ||
        produtoId.includes(termo) ||
        grupoId.includes(termo) ||
        endTxt.includes(termo)
      );
    });

    res.status(200).json(filtrados);
  } catch (e) {
    res.status(500).json({ error: "Erro ao buscar clientes" });
  }
});

app.get("/clientes/:id", async (req, res) => {
  try {
    const ref = db.collection("clientes").doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists)
      return res.status(404).json({ message: "Cliente não encontrado" });
    res.status(200).json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ==============================
// ✅ ATUALIZA CLIENTE + ANTI DUPLICIDADE (ENTRADA)
// + cria/limpa data_venda conforme status_pedido
// + padroniza status_pagamento = Extravio
// ==============================
app.put("/clientes/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const data = req.body;

    const ref = db.collection("clientes").doc(id);
    const doc = await ref.get();
    if (!doc.exists)
      return res.status(404).json({ message: "Cliente não encontrado" });

    const clienteAntes = doc.data();

    const before = {
      status_pagamento: normalizePagamento(clienteAntes.status_pagamento),
      status_extraviado: normalizeExtraviadoSubstatus(
        clienteAntes.status_extraviado
      ),
    };

    const after = {
      status_pagamento:
        data.status_pagamento != null
          ? normalizePagamento(data.status_pagamento)
          : before.status_pagamento,

      status_extraviado:
        data.status_extraviado != null
          ? normalizeExtraviadoSubstatus(data.status_extraviado)
          : before.status_extraviado,
    };

    // Se status_pagamento = Extravio e não mandou substatus, default Aberto
    if (
      after.status_pagamento === "Extravio" &&
      (!data.status_extraviado && !clienteAntes.status_extraviado)
    ) {
      after.status_extraviado = "Aberto";
    }

    const wasPaid = isEffectivePaid(before);
    const isNowPaid = isEffectivePaid(after);

    const payload = { ...data };

    const phoneRaw = data.phone != null ? data.phone : clienteAntes.phone;
const cpfRaw = data.cpf != null ? data.cpf : clienteAntes.cpf;

const checkCliente = await findClienteExistente({
  phone: phoneRaw,
  cpf: cpfRaw,
  excludeId: id,
});

payload.phone_normalizado = checkCliente.phoneNorm;
payload.cpf_cnpj_normalizado = checkCliente.cpfNorm;
payload.ja_e_cliente = checkCliente.exists;
payload.cliente_existente_id = checkCliente.cliente?.id || "";

    // resolve produto/grupo se mudou
    const hasProdutoChange = data.produto != null || data.produtoId != null;
    if (hasProdutoChange) {
      const resolvedProduto = await resolveProdutoFields(data);
      payload.produtoId = resolvedProduto.produtoId || "";
      payload.produto = resolvedProduto.produto || payload.produto || "";
    }
    if (data.grupoId != null) payload.grupoId = String(data.grupoId || "");

    // normaliza pagamento/substatus
    if (data.status_pagamento != null)
      payload.status_pagamento = after.status_pagamento;

    if (data.status_extraviado != null || after.status_pagamento === "Extravio") {
      payload.status_extraviado =
        after.status_pagamento === "Extravio" ? after.status_extraviado : "";
    }
    if (after.status_pagamento !== "Extravio") payload.status_extraviado = "";

    // ✅ data_venda: controla Fechado Hoje e Ranking
    const statusAntes = normalizeString(clienteAntes.status_pedido);
    const statusDepois =
      data.status_pedido != null ? normalizeString(data.status_pedido) : statusAntes;

    // entrou em Vendido agora -> seta data_venda se vazio
    if (statusDepois === "Vendido" && statusAntes !== "Vendido") {
      if (!clienteAntes.data_venda) {
        payload.data_venda = new Date().toISOString();
      }
    }

    // saiu de Vendido (ex: Cancelado) -> limpa data_venda
    if (statusAntes === "Vendido" && statusDepois !== "Vendido") {
      payload.data_venda = "";
    }

    // se virou Cancelado -> garante limpeza
    if (statusDepois === "Cancelado") {
      payload.data_venda = "";
    }

    await ref.update(payload);

    // ✅ limpa cache do dashboard pra refletir na hora
    dashboardCache = null;
    dashboardCacheAt = 0;

    // 2) Se virou "pago efetivo" e antes não era -> cria entrada UMA VEZ
    // 2) Se virou "pago efetivo" -> garante data_pagamento e cria entrada (se faltar)
// (e se já existe entrada, garante data_pagamento preenchida)
if (isNowPaid) {
  const dataPag = data.data_pagamento
  ? normalizeISODateInput_SP(data.data_pagamento)
  : new Date().toISOString();


  const valorEntrada =
    data.valor_pago != null
      ? parseFloat(data.valor_pago)
      : safeNumber((data.valor_total != null ? data.valor_total : clienteAntes.valor_total) || 0);

  const origemPag = data.origem_pagamento || "Pix";

  const clienteAtualizado = await ref.get();
  const clienteAgora = clienteAtualizado.data();

  // ✅ sempre garante data_pagamento se estiver vazio
  if (!clienteAgora.data_pagamento) {
    await ref.update({ data_pagamento: dataPag });
  }

  // ✅ cria entrada se ainda não existir
  if (!clienteAgora.financeiro_entrada_id) {
    const entrada = {
      tipo: "Entrada",
      categoria: "Cliente",
      descricao: clienteAntes.nome || "Cliente sem nome",
      valor: valorEntrada,
      data: dataPag,
      origem: origemPag,
      cliente: { id, nome: clienteAntes.nome, phone: clienteAntes.phone },
      criado_em: new Date().toISOString(),
    };

    const entradaRef = await db.collection("financeiro").add(entrada);

    await ref.update({
      financeiro_entrada_id: entradaRef.id,
      data_pagamento: dataPag,
    });
  } else {
    // opcional: se quiser manter o "financeiro.data" alinhado quando marcar pago manualmente
    // await db.collection("financeiro").doc(clienteAgora.financeiro_entrada_id).update({ data: dataPag });
  }
}


    // 3) Se era "pago efetivo" e deixou de ser -> remove entrada
    if (wasPaid && !isNowPaid) {
      const clienteAtualizado = await ref.get();
      const clienteAgora = clienteAtualizado.data();

      if (clienteAgora.financeiro_entrada_id) {
        await db
          .collection("financeiro")
          .doc(clienteAgora.financeiro_entrada_id)
          .delete();

        await ref.update({
          financeiro_entrada_id: "",
          data_pagamento: "",
        });

        dashboardCache = null;
        dashboardCacheAt = 0;
      }
    }
    invalidateDashboardCache();
    res.status(200).json({ message: "Cliente atualizado com sucesso" });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

function normalizeEnvio(status) {
  const s = normalizeString(status);
  if (!s) return "Ag. Envio";
  const low = s.toLowerCase();

  if (low === "ag. envio" || low === "ag envio" || low === "aguardando envio") return "Ag. Envio";
  if (low === "etiqueta gerada" || low === "etiqueta" || low === "etiqueta-gerada") return "Etiqueta Gerada";
  if (low === "enviado") return "Enviado";
  if (low === "entregue") return "Entregue";
  if (low === "pendente") return "Pendente";
  if (low === "extraviado" || low === "extravio") return "Extravio";
  if (low === "cancelado") return "Cancelado";

  return s; // fallback (mantém compat)
}


// ==============================
// 🚚 ENTREGAS (Etiqueta / Envio) + ESTOQUE + FRETE
// ==============================
app.put("/clientes/:id/entrega", async (req, res) => {
  try {
    const id = req.params.id;
    const { status_envio, codigo_rastreio, valor_envio, data_envio } = req.body;

    const ref = db.collection("clientes").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ message: "Cliente não encontrado" });

    const cliente = doc.data();
    const quantidadePedido = safeInt(cliente.quantidade || 1, 1);

    const statusEnvioFinal = normalizeEnvio(status_envio || cliente.status_envio || "Ag. Envio");


    const dataEnvioFinal = data_envio
      ? new Date(data_envio).toISOString()
      : (cliente.data_envio ? new Date(cliente.data_envio).toISOString() : new Date().toISOString());

    const valorEnvioFinal =
      valor_envio != null ? parseFloat(valor_envio) : safeNumber(cliente.valor_envio || 0);

    const update = {
      status_envio: statusEnvioFinal,
      codigo_rastreio: codigo_rastreio != null ? String(codigo_rastreio) : (cliente.codigo_rastreio || ""),
      valor_envio: valorEnvioFinal,
      data_envio: dataEnvioFinal,
    };

    const sync = {};

    if (statusEnvioFinal === "Entregue") {
  const pagAtual = normalizePagamento(cliente.status_pagamento);
  if (pagAtual !== "Pago") {
    sync.status_pagamento = "Pendente";
    sync.status_extraviado = ""; // opcional: limpa se tiver lixo
  }
}

let nextWhatsappPipelineStatus = "";

if (statusEnvioFinal === "Enviado") {
  nextWhatsappPipelineStatus = "enviado";
}

if (statusEnvioFinal === "Entregue") {
  nextWhatsappPipelineStatus = "a_pagar";
}

if (statusEnvioFinal === "Extravio") {
  nextWhatsappPipelineStatus = "extravio";
}


    if (statusEnvioFinal === "Etiqueta Gerada") {
      // força status_pedido = Vendido
      if (normalizeString(cliente.status_pedido) !== "Vendido") {
        sync.status_pedido = "Vendido";
      }

      // seta data_venda se não existir
      if (!cliente.data_venda) {
        sync.data_venda = new Date().toISOString();
      }

      // ✅ ESTOQUE: debita SOMENTE se tiver grupoId
      if (!cliente.estoque_debitado && normalizeString(cliente.grupoId)) {
        const grupo = await getGrupoById(cliente.grupoId);
        if (!grupo) return res.status(400).json({ error: "Grupo de venda não encontrado" });

        const itens = Array.isArray(grupo.itens) ? grupo.itens : [];
        if (!itens.length) return res.status(400).json({ error: "Grupo sem itens" });

        for (const it of itens) {
          const produtoId = String(it.produtoId || "");
          const qtdGrupo = safeInt(it.quantidade || 0, 0);
          const qtdDebitar = qtdGrupo * quantidadePedido;
          if (!produtoId || qtdDebitar <= 0) continue;

          const est = await getEstoqueById(produtoId);
          if (!est) return res.status(400).json({ error: `Produto do grupo não existe no estoque: ${produtoId}` });

          const estoqueAtual = safeInt(est.quantidade || 0, 0);
          if (estoqueAtual < qtdDebitar) {
            return res.status(400).json({
              error: `Estoque insuficiente de ${est.produto}. Atual: ${estoqueAtual}, precisa: ${qtdDebitar}`,
            });
          }

          await db.collection("estoque").doc(est.id).update({
            quantidade: estoqueAtual - qtdDebitar,
            atualizado_em: new Date().toISOString(),
          });
        }

        sync.estoque_debitado = true;
      }

      
    }

    await ref.update({ ...update, ...sync });

if (nextWhatsappPipelineStatus) {
  const whatsappSnapshot = await db
    .collection("whatsapp_conversas")
    .where("clientId", "==", String(id))
    .limit(20)
    .get();

  if (!whatsappSnapshot.empty) {
    const batch = db.batch();

    whatsappSnapshot.docs.forEach((doc) => {
      const conversa = doc.data();

      if (conversa.deleted || conversa.deletedAt) return;

      batch.set(
        doc.ref,
        {
          pipelineStatus: nextWhatsappPipelineStatus,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );
    });

    await batch.commit();
  }
}

invalidateDashboardCache();

return res.status(200).json({
  message: "Entrega atualizada",
  update,
  sync,
  whatsappPipelineStatus: nextWhatsappPipelineStatus,
});
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});





// ==============================
// 📦 ESTOQUE
// ==============================
app.post("/estoque", async (req, res) => {
  try {
    const { produto, quantidade, custo_unitario } = req.body;
    if (!produto || quantidade == null) {
      return res
        .status(400)
        .json({ error: "Campos obrigatórios: produto, quantidade" });
    }

    const ref = await db.collection("estoque").add({
      produto: normalizeString(produto),
      quantidade: parseInt(quantidade, 10),
      custo_unitario: custo_unitario != null ? parseFloat(custo_unitario) : 0,
      atualizado_em: new Date().toISOString(),
    });

    res
      .status(201)
      .json({ message: "Produto adicionado no estoque", id: ref.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/estoque", async (_, res) => {
  try {
    const snap = await db.collection("estoque").orderBy("produto", "asc").get();
    const itens = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(itens);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put("/estoque/:id", async (req, res) => {
  try {
    const { quantidade, custo_unitario } = req.body;

    const ref = db.collection("estoque").doc(req.params.id);
    const doc = await ref.get();
    if (!doc.exists)
      return res.status(404).json({ message: "Produto não encontrado" });

    const update = { atualizado_em: new Date().toISOString() };
    if (quantidade != null) update.quantidade = parseInt(quantidade, 10);
    if (custo_unitario != null)
      update.custo_unitario = parseFloat(custo_unitario);

    if (quantidade == null && custo_unitario == null) {
      return res.status(400).json({ error: "Envie quantidade e/ou custo_unitario" });
    }

    await ref.update(update);
    res.status(200).json({ message: "Estoque atualizado" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/estoque/busca", async (req, res) => {
  try {
    const { produto } = req.query;
    if (!produto)
      return res.status(400).json({ error: "Query obrigatória: produto" });

    const snap = await db
      .collection("estoque")
      .where("produto", "==", normalizeString(produto))
      .limit(1)
      .get();

    if (snap.empty)
      return res
        .status(404)
        .json({ message: "Produto não encontrado no estoque" });

    const doc = snap.docs[0];
    res.status(200).json({ id: doc.id, ...doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/estoque/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const ref = db.collection("estoque").doc(id);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Produto não encontrado no estoque." });
    }

    await ref.delete();
    return res.json({ ok: true, id });
  } catch (err) {
    console.error("Erro ao deletar estoque:", err);
    return res.status(500).json({ error: "Erro ao deletar produto do estoque." });
  }
});

// ==============================
// ❌ CANCELAR PEDIDO
// ==============================
app.patch("/clientes/:id/cancelar", async (req, res) => {
  try {
    const id = req.params.id;
    const ref = db.collection("clientes").doc(id);
    const doc = await ref.get();
    if (!doc.exists)
      return res.status(404).json({ message: "Cliente não encontrado" });

    const cliente = doc.data();
    const quantidadePedido = safeInt(cliente.quantidade || 1, 1);

    // ✅ ESTOQUE: devolve SOMENTE se for grupoId (regra nova)
    if (cliente.estoque_debitado && normalizeString(cliente.grupoId)) {
      const grupo = await getGrupoById(cliente.grupoId);
      const itens = Array.isArray(grupo?.itens) ? grupo.itens : [];

      for (const it of itens) {
        const produtoId = String(it.produtoId || "");
        const qtdGrupo = safeInt(it.quantidade || 0, 0);
        const qtdDevolver = qtdGrupo * quantidadePedido;
        if (!produtoId || qtdDevolver <= 0) continue;

        const est = await getEstoqueById(produtoId);
        if (!est) continue;

        const estoqueAtual = safeInt(est.quantidade || 0, 0);
        await db.collection("estoque").doc(est.id).update({
          quantidade: estoqueAtual + qtdDevolver,
          atualizado_em: new Date().toISOString(),
        });
      }
    }

    if (cliente.financeiro_frete_id) {
      await db.collection("financeiro").doc(cliente.financeiro_frete_id).delete();
    }
    if (cliente.financeiro_entrada_id) {
      await db.collection("financeiro").doc(cliente.financeiro_entrada_id).delete();
    }

    await ref.update({
      status_pedido: "Cancelado",
      status_envio: "Cancelado",
      status_pagamento: "Pendente",
      status_extraviado: "",
      codigo_rastreio: "",
      valor_envio: 0,
      data_envio: "",
      estoque_debitado: false,
      financeiro_frete_id: "",
      financeiro_entrada_id: "",
      data_pagamento: "",
      data_venda: "",
    });

    dashboardCache = null;
    dashboardCacheAt = 0;
    invalidateDashboardCache();

    res
      .status(200)
      .json({ message: "Pedido cancelado e reversões aplicadas com sucesso" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// ==============================
// 💰 FINANCEIRO
// ==============================
app.post("/financeiro", async (req, res) => {
  try {
    const { tipo, categoria, descricao, valor, data, origem, clienteId } = req.body;
    if (!tipo || valor == null)
      return res.status(400).json({ error: "Campos obrigatórios: tipo e valor" });

    let clienteInfo = null;
    if (clienteId) {
      const c = await db.collection("clientes").doc(clienteId).get();
      if (c.exists)
        clienteInfo = { id: clienteId, nome: c.data().nome, phone: c.data().phone };
    }

    const registro = {
      tipo,
      categoria: categoria || "Outros",
      descricao: descricao || "",
      valor: parseFloat(valor),
      data: data ? new Date(data).toISOString() : new Date().toISOString(),
      origem: origem || "manual",
      cliente: clienteInfo,
      criado_em: new Date().toISOString(),
    };

    const ref = await db.collection("financeiro").add(registro);

    dashboardCache = null;
    dashboardCacheAt = 0;

    res.status(201).json({ message: "Registro criado com sucesso", id: ref.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/financeiro", async (_, res) => {
  try {
    const snap = await db.collection("financeiro").orderBy("data", "desc").get();
    const registros = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(registros);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete("/financeiro/limpar", async (req, res) => {
  try {
    const { confirm } = req.query;

    if (confirm !== "ZERAR_FINANCEIRO") {
      return res.status(400).json({
        error: "Confirmação inválida. Use ?confirm=ZERAR_FINANCEIRO",
      });
    }

    const snap = await db.collection("financeiro").get();

    const batchSize = 400;
    let deleted = 0;

    for (let i = 0; i < snap.docs.length; i += batchSize) {
      const batch = db.batch();
      const docs = snap.docs.slice(i, i + batchSize);

      docs.forEach((doc) => batch.delete(doc.ref));

      await batch.commit();
      deleted += docs.length;
    }

    return res.json({
      success: true,
      deleted,
      message: "Financeiro zerado com sucesso. Clientes não foram alterados.",
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get("/financeiro/filtro", async (req, res) => {
  try {
    const { tipo, inicio, fim } = req.query;
    let q = db.collection("financeiro");
    if (tipo) q = q.where("tipo", "==", tipo);

    const range = normalizeRangeISO(inicio, fim);
    if (range.inicio && range.fim) {
      q = q.where("data", ">=", range.inicio).where("data", "<=", range.fim);
    }

    const snap = await q.orderBy("data", "desc").get();
    const registros = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    res.status(200).json(registros);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==============================
// 📊 RESUMO FINANCEIRO
// ==============================
app.get("/resumo/financeiro", async (req, res) => {
  try {
    const { inicio, fim } = req.query;
    let q = db.collection("financeiro");

    const range = normalizeRangeISO(inicio, fim);
    if (range.inicio) range.inicio = clampInicioRange(range.inicio);
if (!range.inicio) range.inicio = SYSTEM_START_ISO;


    if (range.inicio && range.fim) {
      q = q.where("data", ">=", range.inicio).where("data", "<=", range.fim);
    }

    const snap = await q.get();
    const registros = snap.docs.map((d) => d.data());

    const totalEntradas = registros
      .filter((r) => String(r.tipo || "").toLowerCase() === "entrada")
      .reduce((sum, r) => sum + (r.valor || 0), 0);

    const totalSaidas = registros
      .filter((r) => {
        const t = String(r.tipo || "").toLowerCase();
        return t === "saída" || t === "saida";
      })
      .reduce((sum, r) => sum + (r.valor || 0), 0);

    const saldo = totalEntradas - totalSaidas;

    res.status(200).json({
      periodo: range.inicio && range.fim ? `${range.inicio} → ${range.fim}` : "Geral",
      totalEntradas,
      totalSaidas,
      saldo,
      registros: registros.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==============================
// 📈 DASHBOARD (HOJE + ONTEM) - FUSO SP
// REGRAS:
// - Gerado Hoje: por data_criacao
// - Fechado Hoje: status_pedido === "Vendido" por data_venda (se tiver) senão data_criacao
// - Recebido Hoje: por data_pagamento + isEffectivePaid (Pago ou Extravio+Pago)
// - Cancelado: nunca entra em Fechado/Recebido/Concluído/Ranking
// ==============================
function uniqById(list) {
  const map = new Map();
  for (const item of list) map.set(item.id, item);
  return Array.from(map.values());
}

async function calcCustoGrupo(grupoId, qtdPedido) {
  if (!grupoId) return 0;

  const grupo = await getGrupoById(String(grupoId));
  if (!grupo) return 0;

  // pega custos do estoque por produtoId
  const estoqueSnap = await db.collection("estoque").get();
  const estoqueById = new Map();
  estoqueSnap.docs.forEach((d) => estoqueById.set(d.id, d.data()));

  let custoKit = 0;

  const itens = Array.isArray(grupo.itens) ? grupo.itens : [];
  for (const it of itens) {
    const prodId = String(it.produtoId || "");
    const qtd = safeInt(it.quantidade || 0, 0);
    if (!prodId || qtd <= 0) continue;

    const est = estoqueById.get(prodId);
    const custoUnit = safeNumber(est?.custo_unitario || 0);

    custoKit += custoUnit * qtd;
  }

  return custoKit * safeInt(qtdPedido || 1, 1);
}

function addDays(dateObj, amount) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + amount);
  return d;
}

function startOfMonthISO_SP(dateObj) {
  const tz = "America/Sao_Paulo";
  const p = tzParts(tz, dateObj);

  const approx = new Date(
    Date.UTC(Number(p.year), Number(p.month) - 1, 1, 0, 0, 0, 0)
  );

  const offMin = tzOffsetMinutes(tz, approx);
  return new Date(approx.getTime() - offMin * 60000).toISOString();
}

function endOfMonthISO_SP(dateObj) {
  const tz = "America/Sao_Paulo";
  const p = tzParts(tz, dateObj);

  const lastDay = new Date(
    Number(p.year),
    Number(p.month),
    0
  ).getDate();

  const approx = new Date(
    Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      lastDay,
      23,
      59,
      59,
      999
    )
  );

  const offMin = tzOffsetMinutes(tz, approx);
  return new Date(approx.getTime() - offMin * 60000).toISOString();
}

function startOfWeekISO_SP(dateObj) {
  const tz = "America/Sao_Paulo";
  const p = tzParts(tz, dateObj);

  const localDate = new Date(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day)
  );

  const day = localDate.getDay(); // domingo 0
  const diffToMonday = day === 0 ? -6 : 1 - day;

  localDate.setDate(localDate.getDate() + diffToMonday);

  return startOfDayISO_SP(localDate);
}

function endOfWeekISO_SP(dateObj) {
  const tz = "America/Sao_Paulo";
  const p = tzParts(tz, dateObj);

  const localDate = new Date(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day)
  );

  const day = localDate.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;

  localDate.setDate(localDate.getDate() + diffToMonday + 6);

  return endOfDayISO_SP(localDate);
}

function dateOnlyToStartISO_SP(value) {
  const s = String(value || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";

  return new Date(`${s}T00:00:00.000-03:00`).toISOString();
}

function dateOnlyToEndISO_SP(value) {
  const s = String(value || "").trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";

  return new Date(`${s}T23:59:59.999-03:00`).toISOString();
}

function getDashboardRange(periodo, inicioQuery, fimQuery) {
  const hoje = new Date();
  const ontem = addDays(hoje, -1);

  if (periodo === "ontem") {
    return {
      label: "Ontem",
      inicio: startOfDayISO_SP(ontem),
      fim: endOfDayISO_SP(ontem),
      comparativoInicio: startOfDayISO_SP(addDays(ontem, -1)),
      comparativoFim: endOfDayISO_SP(addDays(ontem, -1)),
      comparativoLabel: "Dia anterior",
    };
  }

  if (periodo === "semana") {
    const inicio = startOfWeekISO_SP(hoje);
    const fim = endOfWeekISO_SP(hoje);

    const semanaAnteriorBase = addDays(new Date(inicio), -1);

    return {
      label: "Semana",
      inicio,
      fim,
      comparativoInicio: startOfWeekISO_SP(semanaAnteriorBase),
      comparativoFim: endOfWeekISO_SP(semanaAnteriorBase),
      comparativoLabel: "Semana anterior",
    };
  }

  if (periodo === "mes") {
    const inicio = startOfMonthISO_SP(hoje);
    const fim = endOfMonthISO_SP(hoje);

    const mesAnteriorBase = new Date(hoje);
    mesAnteriorBase.setMonth(mesAnteriorBase.getMonth() - 1);

    return {
      label: "Mês",
      inicio,
      fim,
      comparativoInicio: startOfMonthISO_SP(mesAnteriorBase),
      comparativoFim: endOfMonthISO_SP(mesAnteriorBase),
      comparativoLabel: "Mês anterior",
    };
  }

  if (periodo === "mes_passado") {
    const mesPassadoBase = new Date(hoje);
    mesPassadoBase.setMonth(mesPassadoBase.getMonth() - 1);

    const doisMesesAtrasBase = new Date(hoje);
    doisMesesAtrasBase.setMonth(doisMesesAtrasBase.getMonth() - 2);

    return {
      label: "Mês passado",
      inicio: startOfMonthISO_SP(mesPassadoBase),
      fim: endOfMonthISO_SP(mesPassadoBase),
      comparativoInicio: startOfMonthISO_SP(doisMesesAtrasBase),
      comparativoFim: endOfMonthISO_SP(doisMesesAtrasBase),
      comparativoLabel: "Mês anterior",
    };
  }

  if (periodo === "personalizado") {
    const inicio = dateOnlyToStartISO_SP(inicioQuery);
    const fim = dateOnlyToEndISO_SP(fimQuery);

    if (!inicio || !fim) {
      throw new Error("Para período personalizado, envie inicio e fim no formato YYYY-MM-DD.");
    }

    const inicioDate = new Date(inicio);
    const fimDate = new Date(fim);
    const diffMs = fimDate.getTime() - inicioDate.getTime();
    const comparativoFimDate = addDays(inicioDate, -1);
    const comparativoInicioDate = new Date(
      comparativoFimDate.getTime() - diffMs
    );

    return {
      label: "Personalizado",
      inicio,
      fim,
      comparativoInicio: comparativoInicioDate.toISOString(),
      comparativoFim: endOfDayISO_SP(comparativoFimDate),
      comparativoLabel: "Período anterior",
    };
  }

  return {
    label: "Hoje",
    inicio: startOfDayISO_SP(hoje),
    fim: endOfDayISO_SP(hoje),
    comparativoInicio: startOfDayISO_SP(ontem),
    comparativoFim: endOfDayISO_SP(ontem),
    comparativoLabel: "Ontem",
  };
}

async function calcularDashboardDoDia(dateObj) {
  let inicio = customRange?.inicio || startOfDayISO_SP(dateObj);
  const fim = customRange?.fim || endOfDayISO_SP(dateObj);

  // ✅ aplica o CORTE do sistema
  inicio = clampInicioRange(inicio);

  // 1) GERADO HOJE (data_criacao)
  const clientesDoDiaSnap = await db
    .collection("clientes")
    .where("data_criacao", ">=", inicio)
    .where("data_criacao", "<=", fim)
    .get();

  const clientesDoDia = clientesDoDiaSnap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  const geradoHoje = {
    quantidade_clientes: clientesDoDia.length,
    soma_valor_total: clientesDoDia.reduce((s, c) => s + safeNumber(c.valor_total), 0),
  };

  // 2) FECHADO HOJE (status_pedido === "Vendido")
  // 2.1) por data_venda
  const vendidosPorDataVendaSnap = await db
    .collection("clientes")
    .where("data_venda", ">=", inicio)
    .where("data_venda", "<=", fim)
    .get();

  const vendidosPorDataVenda = vendidosPorDataVendaSnap.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  }));

  // 2.2) fallback por data_criacao (pra quem não tem data_venda ainda)
  const vendidosPorCriacao = clientesDoDia.filter(
    (c) => normalizeString(c.status_pedido) === "Vendido" && !c.data_venda
  );

  // ✅ entra só Vendido (se voltou p/ Aberto/Novo/Cancelado, some)
  const vendidosHojeAll = uniqById([
    ...vendidosPorDataVenda.filter((c) => normalizeString(c.status_pedido) === "Vendido"),
    ...vendidosPorCriacao,
  ]).filter((c) => normalizeString(c.status_pedido) === "Vendido");

  const fechadoHoje = {
    quantidade: vendidosHojeAll.length,
    soma_valor_total: vendidosHojeAll.reduce((s, c) => s + safeNumber(c.valor_total), 0),
  };

  // 3) RECEBIDO HOJE (data_pagamento + efetivamente pago)
  const recebidosSnap = await db
    .collection("clientes")
    .where("data_pagamento", ">=", inicio)
    .where("data_pagamento", "<=", fim)
    .get();

  const recebidosAll = recebidosSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  // ✅ corta cancelados + só efetivamente pago
  const recebidos = recebidosAll.filter(
    (c) => normalizeString(c.status_pedido) !== "Cancelado" && isEffectivePaid(c)
  );

  const recebidoHoje = {
    quantidade: recebidos.length,
    soma_valor_total: recebidos.reduce((s, c) => s + safeNumber(c.valor_total), 0),
  };

  // 4) CONCLUÍDO HOJE (Etiqueta Gerada) por data_envio
  const concluidasSnap = await db
    .collection("clientes")
    .where("data_envio", ">=", inicio)
    .where("data_envio", "<=", fim)
    .get();

  const concluidasAll = concluidasSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

  const concluidas = concluidasAll.filter(
    (c) =>
      normalizeString(c.status_pedido) !== "Cancelado" &&
      normalizeString(c.status_envio) === "Etiqueta Gerada"
  );

  const concluidoHoje = {
    quantidade: concluidas.length,
    soma_valor_total: concluidas.reduce((s, c) => s + safeNumber(c.valor_total), 0),
  };

  // 5) FRETE HOJE (Regra: 15 * vendidos do dia)
  // ✅ você pediu: sempre puxar 15,00 dos vendidos (não depende do financeiro)
  const FRETE_FIXO = 15;
  const gastoFrete = vendidosHojeAll.reduce((s, c) => s + FRETE_FIXO * safeInt(c.quantidade || 1, 1), 0);

  // 6) custo dos produtos (custo total do grupo) baseado nos vendidos do dia
  // ✅ regra: custo do produto = soma dos itens do grupo * qtd
  // fallback: se não tiver grupo, tenta custo_unitario do produto no estoque
  const estoqueSnap = await db.collection("estoque").get();
  const estoqueById = new Map();
  const estoqueByNome = new Map();
  estoqueSnap.docs.forEach((doc) => {
    const it = doc.data();
    estoqueById.set(String(doc.id), safeNumber(it.custo_unitario));
    estoqueByNome.set(normalizeString(it.produto), safeNumber(it.custo_unitario));
  });

  const gruposSnap = await db.collection("grupos_venda").get();
  const grupoMap = new Map();
  gruposSnap.docs.forEach((doc) => {
    const g = doc.data();
    grupoMap.set(String(doc.id), { id: doc.id, ...g });
  });

  function calcCustoGrupo(grupo, qtdPedidos) {
    const itens = Array.isArray(grupo?.itens) ? grupo.itens : [];
    let custo1x = 0;

    for (const it of itens) {
      const pid = String(it.produtoId || "");
      const q = safeInt(it.quantidade || 0, 0);
      const custoUnit = estoqueById.get(pid) || 0;
      custo1x += custoUnit * q;
    }

    return custo1x * safeInt(qtdPedidos || 1, 1);
  }

  const gastoProdutos = vendidosHojeAll.reduce((s, c) => {
    const qtdPedido = safeInt(c.quantidade || 1, 1);

    // se tem grupoId: custo vem do grupo
    if (c.grupoId) {
      const grupo = grupoMap.get(String(c.grupoId));
      if (grupo) return s + calcCustoGrupo(grupo, qtdPedido);
    }

    // fallback: custo do produto no estoque
    const custoUnit =
      (c.produtoId ? estoqueById.get(String(c.produtoId)) : 0) ||
      estoqueByNome.get(normalizeString(c.produto)) ||
      0;

    return s + custoUnit * qtdPedido;
  }, 0);

  // 7) ranking por vendedor (HOJE) - mantém como estava no dashboard diário
  const ranking = {};
  for (const c of vendidosHojeAll) {
    const v = normalizeString(c.seller) || "Sem vendedor";
    if (!ranking[v]) ranking[v] = { vendedor: v, fechado: 0, concluido: 0 };
    ranking[v].fechado += safeNumber(c.valor_total);
  }
  for (const c of concluidas) {
    const v = normalizeString(c.seller) || "Sem vendedor";
    if (!ranking[v]) ranking[v] = { vendedor: v, fechado: 0, concluido: 0 };
    ranking[v].concluido += safeNumber(c.valor_total);
  }

  const rankingArray = Object.values(ranking).sort(
    (a, b) => b.fechado + b.concluido - (a.fechado + a.concluido)
  );

  // 8) total do dia
  const totalDia = concluidoHoje.soma_valor_total - gastoFrete - gastoProdutos;

  // 9) taxa de fechamento (baseado no recebido)
  // regra: fechado / recebido (valor) * 100
  const taxaFechamento = safeNumber(recebidoHoje.soma_valor_total)
    ? (safeNumber(fechadoHoje.soma_valor_total) / safeNumber(recebidoHoje.soma_valor_total)) * 100
    : 0;

  return {
    data: customRange?.label || formatDateKeySP(dateObj),
    periodo: { inicio, fim },

    geradoHoje,
    fechadoHoje,
    recebidoHoje,
    concluidoHoje,

    gastoFrete,
    gastoProdutos,
    totalDia,

    // ✅ novo campo (não quebra front antigo)
    taxaFechamento,

    ranking: rankingArray,
  };
}



let dashboardCache = null;
let dashboardCacheAt = 0;

function invalidateDashboardCache() {
  dashboardCache = null;
  dashboardCacheAt = 0;
}


app.get("/dashboard/diario", async (req, res) => {
  try {
    const { periodo = "hoje", inicio, fim } = req.query;

    const periodoNormalizado = String(periodo || "hoje");

    const isDefaultHoje =
      periodoNormalizado === "hoje" && !inicio && !fim;

    const now = Date.now();

    // cache por 2 minutos somente no padrão "hoje"
    if (
      isDefaultHoje &&
      dashboardCache &&
      now - dashboardCacheAt < 2 * 60 * 1000
    ) {
      return res.json(dashboardCache);
    }

    const range = getDashboardRange(periodoNormalizado, inicio, fim);

    const dashPrincipal = await calcularDashboardDoDia(new Date(), {
      inicio: range.inicio,
      fim: range.fim,
      label: range.label,
    });

    const dashComparativo = await calcularDashboardDoDia(new Date(), {
      inicio: range.comparativoInicio,
      fim: range.comparativoFim,
      label: range.comparativoLabel,
    });

    // ✅ RANKING GERAL (ALL-TIME)
    const rankingGeral = await calcularRankingGeral();

    // ✅ mantém o nome "ranking" para não quebrar o front
    dashPrincipal.ranking = rankingGeral;
    dashComparativo.ranking = rankingGeral;

    const payload = {
      hoje: dashPrincipal,
      ontem: dashComparativo,
      filtro: {
        periodo: periodoNormalizado,
        label: range.label,
        inicio: range.inicio,
        fim: range.fim,
        comparativoLabel: range.comparativoLabel,
        comparativoInicio: range.comparativoInicio,
        comparativoFim: range.comparativoFim,
      },
    };

    if (isDefaultHoje) {
      dashboardCache = payload;
      dashboardCacheAt = now;
    }

    return res.json(payload);
  } catch (e) {
    console.error("Erro dashboard:", e);
    return res.status(500).json({
      error: e.message || "Erro ao gerar dashboard",
    });
  }
});

// ==============================
// 🧾 ASAAS - GERAR BOLETO (PRODUÇÃO)
// Fluxo: você clica no CRM -> modal pede CPF + vencimento -> gera boleto
// ==============================
app.post("/clientes/:id/gerar-boleto", async (req, res) => {
  try {
    const id = req.params.id;
    const { cpf, dueDate } = req.body;

    if (!cpf) return res.status(400).json({ error: "CPF é obrigatório" });
    if (!dueDate) return res.status(400).json({ error: "dueDate é obrigatório (YYYY-MM-DD)" });

    if (!isValidCpfCnpj(cpf)) {
      return res.status(400).json({ error: "CPF/CNPJ inválido (precisa ter 11 ou 14 dígitos)" });
    }

    const ref = db.collection("clientes").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Cliente não encontrado" });

    const cliente = doc.data();

    const nome = String(cliente.nome || "").trim();
    if (!nome) return res.status(400).json({ error: "Cliente está sem nome" });

    const valorFinal = Number(cliente.valor_total || 0);
    if (!Number.isFinite(valorFinal) || valorFinal <= 0) {
      return res.status(400).json({ error: "Cliente com valor_total inválido para gerar boleto" });
    }

    const asaasInfo = ensureAsaasObj(cliente);

    // 1) Garantir customerId
    let customerId = asaasInfo.customerId;

    const cpfCnpj = onlyDigits(cpf);
    const mobilePhone = onlyDigits(cliente.phone || "");

    if (!customerId) {
      const custResp = await asaas.post("/v3/customers", {
        name: nome,
        cpfCnpj,
        mobilePhone,
      });

      customerId = custResp.data.id;

      await ref.update({
        cpf: cpfCnpj,
        asaas: {
          ...asaasInfo,
          customerId,
          updatedAt: new Date().toISOString(),
        },
      });
    } else {
      // opcional: salvar cpf
      if (!cliente.cpf) await ref.update({ cpf: cpfCnpj });
    }

    // 2) Criar cobrança (boleto)
    const payResp = await asaas.post("/v3/payments", {
      customer: customerId,
      billingType: "BOLETO",
      value: valorFinal,
      dueDate,
      description: `Boleto - Pedido ${id} - ${nome}`,
      externalReference: String(id),
    });

    const p = payResp.data;

    // 3) Persistir no cliente
    const currentDoc = await ref.get();
    const currentCliente = currentDoc.data() || {};

    await ref.update({
      asaas: {
        ...ensureAsaasObj(currentCliente),
        customerId,
        paymentId: p.id || "",
        bankSlipUrl: p.bankSlipUrl || "",
        invoiceUrl: p.invoiceUrl || "",
        status: p.status || "",
        lastEvent: "PAYMENT_CREATED",
        updatedAt: new Date().toISOString(),
      },
    });

    // 4) Retornar cliente REAL atualizado
    const updatedDoc = await ref.get();
    const updatedCliente = { id: updatedDoc.id, ...updatedDoc.data() };

    return res.json({
      ok: true,
      cliente: updatedCliente,
      paymentId: p.id,
      status: p.status,
      bankSlipUrl: p.bankSlipUrl,
      invoiceUrl: p.invoiceUrl,
    });
  } catch (e) {
    return res.status(e?.response?.status || 500).json({
      error: "Erro ao gerar boleto no Asaas",
      details: e?.response?.data || e.message,
    });
  }
});

app.get("/clientes/:id/boleto/download", async (req, res) => {
  try {
    const id = req.params.id;

    const ref = db.collection("clientes").doc(id);
    const doc = await ref.get();
    if (!doc.exists) return res.status(404).json({ error: "Cliente não encontrado" });

    const cliente = doc.data();
    const url = cliente?.asaas?.bankSlipUrl;
    if (!url) return res.status(400).json({ error: "Cliente não possui boleto" });

    // baixa o PDF do Asaas e devolve como arquivo
    const axios = require("axios");
    const r = await axios.get(url, { responseType: "arraybuffer" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="boleto-${id}.pdf"`);
    return res.send(Buffer.from(r.data));
  } catch (e) {
    return res.status(500).json({ error: "Erro ao baixar boleto", details: e.message });
  }
});

function buildRastreioZapPayload(cliente, clienteId) {
  const endereco = cliente.endereco || {};

  const quantidade = safeInt(cliente.quantidade || 1, 1);
  const valorTotal = safeNumber(cliente.valor_total || 0);
  const valorFrete = safeNumber(cliente.valor_envio || cliente.valor_frete || 0);

  return {
    external_id_order: normalizePhoneBR(cliente.phone),
    origin_order: cliente.origem || "Checkout",
    total_price: Number(valorTotal.toFixed(3)),
    price_shipping: Number(valorFrete.toFixed(3)),
    discount_value: 0,
    lines_transport: {
      delivery_postal_code: cliente.codigo_rastreio,
      shipping_company: "Loggi",
      order_status_id: 1
    },
    line_items: [
      {
        title: "ERON MAX",
        quantity: quantidade,
        price: Number((quantidade > 0 ? valorTotal / quantidade : valorTotal).toFixed(4))
      }
    ],
    client: {
      internal_id: 0,
      automatic_identify: true,
      full_name: cliente.nome,
      cpf_cnpj: normalizeCpfCnpj(10335876056),
      telephone: normalizePhoneBR(cliente.phone),
      email: cliente.email || "emidio@gmail.com"
    },
    delivery_address: {
      address: endereco.logradouro || cliente.endereco?.logradouro || "",
      zip_code: onlyDigits(endereco.cep || ""),
      city: endereco.localidade || "",
      state: endereco.uf || endereco.estado || "",
      country: "Brasil"
    }
  };
}

app.post("/clientes/:id/rastreiozap", async (req, res) => {
  try {
    const { id } = req.params;
    const { force = false } = req.body || {};

    const ref = db.collection("clientes").doc(id);
    const doc = await ref.get();

    if (!doc.exists) {
      return res.status(404).json({ error: "Cliente não encontrado" });
    }

    const cliente = doc.data();

    if (cliente.rastreiozap_gerado && !force) {
      return res.status(400).json({
        error: "Pedido já foi enviado ao RastreioZap para este cliente",
        rastreiozap_gerado: true,
        rastreiozap_gerado_em: cliente.rastreiozap_gerado_em || "",
        rastreiozap_order_id: cliente.rastreiozap_order_id || ""
      });
    }

    const payload = buildRastreioZapPayload(cliente, id);

    const response = await fetch(process.env.RASTREIOZAP_API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.RASTREIOZAP_API_TOKEN}`
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();
    let responseData = null;

    try {
      responseData = responseText ? JSON.parse(responseText) : null;
    } catch {
      responseData = { raw: responseText };
    }

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Erro ao enviar pedido para o RastreioZap",
        details: responseData
      });
    }

    await ref.update({
      rastreiozap_gerado: true,
      rastreiozap_gerado_em: new Date().toISOString(),
      rastreiozap_order_id:
        responseData?.id ||
        responseData?.order_id ||
        responseData?.data?.id ||
        "",
    });

    return res.status(200).json({
      message: "Pedido enviado ao RastreioZap com sucesso",
      payload_enviado: payload,
      response: responseData
    });
  } catch (e) {
    return res.status(500).json({
      error: "Erro interno ao enviar para o RastreioZap",
      details: e.message
    });
  }
});

app.listen(PORT, () => console.log(`🚀 API rodando na porta ${PORT}`));
