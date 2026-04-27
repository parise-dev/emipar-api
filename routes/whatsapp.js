const express = require("express");
const axios = require("axios");
const multer = require("multer");
const FormData = require("form-data");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");  
const db = require("../firebase");

ffmpeg.setFfmpegPath(ffmpegPath);

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const API_VERSION = process.env.WHATSAPP_API_VERSION || "v23.0";

const GRAPH_URL = `https://graph.facebook.com/${API_VERSION}`;

function graphHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  };
}

function nowISO() {
  return new Date().toISOString();
}

async function convertAudioToOgg(buffer, originalName = "audio.webm") {
  const tempDir = os.tmpdir();

  const timestamp = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  const inputExt = path.extname(originalName) || ".webm";

  const inputPath = path.join(tempDir, `input-${timestamp}${inputExt}`);
  const outputPath = path.join(tempDir, `output-${timestamp}.ogg`);

  fs.writeFileSync(inputPath, buffer);

  await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec("libopus")
      .audioChannels(1)
      .audioFrequency(48000)
      .audioBitrate("32k")
      .format("ogg")
      .outputOptions([
        "-application voip",
        "-compression_level 10",
        "-map_metadata -1",
      ])
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });

  const convertedBuffer = fs.readFileSync(outputPath);

  try {
    fs.unlinkSync(inputPath);
  } catch {}

  try {
    fs.unlinkSync(outputPath);
  } catch {}

  return convertedBuffer;
}

function normalizeWaPhone(phone = "") {
  const onlyNumbers = String(phone).replace(/\D/g, "");

  if (!onlyNumbers) return "";

  if (onlyNumbers.startsWith("55")) {
    return onlyNumbers;
  }

  return `55${onlyNumbers}`;
}

async function saveMessage(data) {
  await db.collection("whatsapp_mensagens").add({
    ...data,
    createdAt: nowISO(),
  });
}

async function getWhatsappMediaUrl(mediaId) {
  const response = await axios.get(`${GRAPH_URL}/${mediaId}`, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
    },
  });

  return response.data?.url || "";
}


// WEBHOOK VERIFY
router.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// WEBHOOK RECEIVE
// WEBHOOK RECEIVE
router.post("/webhook", async (req, res) => {
  try {
    const entries = req.body?.entry || [];

    for (const entry of entries) {
      const changes = entry?.changes || [];

      for (const change of changes) {
        const value = change?.value;

        const messages = value?.messages || [];
        const statuses = value?.statuses || [];
        const contacts = value?.contacts || [];

        for (const msg of messages) {
          const contact = contacts?.[0];
          const from = normalizeWaPhone(msg.from);
          const contactName = contact?.profile?.name || from;

          let text = "";
let mediaId = "";
let mediaUrl = "";
let mimeType = "";
let fileName = "";

if (msg.type === "text") {
  text = msg.text?.body || "";
}

if (msg.type === "button") {
  text = msg.button?.text || "";
}

if (msg.type === "interactive") {
  text =
    msg.interactive?.button_reply?.title ||
    msg.interactive?.list_reply?.title ||
    "";
}

if (msg.type === "audio") {
  mediaId = msg.audio?.id || "";
  mimeType = msg.audio?.mime_type || "";
  text = "🎤 Áudio recebido";
}

if (msg.type === "image") {
  mediaId = msg.image?.id || "";
  mimeType = msg.image?.mime_type || "";
  text = msg.image?.caption || "🖼️ Imagem recebida";
}

if (msg.type === "document") {
  mediaId = msg.document?.id || "";
  mimeType = msg.document?.mime_type || "";
  fileName = msg.document?.filename || "";
  text = msg.document?.caption || `📄 Documento recebido${fileName ? `: ${fileName}` : ""}`;
}

if (msg.type === "video") {
  mediaId = msg.video?.id || "";
  mimeType = msg.video?.mime_type || "";
  text = msg.video?.caption || "🎥 Vídeo recebido";
}

if (mediaId) {
  try {
    mediaUrl = await getWhatsappMediaUrl(mediaId);
  } catch (mediaError) {
    console.error("Erro ao buscar URL da mídia:", mediaError.response?.data || mediaError.message);
  }
}

          const existingConversation = await db
            .collection("whatsapp_conversas")
            .where("phone", "==", from)
            .limit(1)
            .get();

          let conversationId = "";

          if (!existingConversation.empty) {
            conversationId = existingConversation.docs[0].id;

            await db.collection("whatsapp_conversas").doc(conversationId).set(
              {
                name: contactName,
                phone: from,
                lastMessage: text || `[${msg.type}]`,
                lastTime: nowISO(),
                unread: (existingConversation.docs[0].data().unread || 0) + 1,
                updatedAt: nowISO(),
              },
              { merge: true }
            );
          } else {
            const newConversationRef = await db
              .collection("whatsapp_conversas")
              .add({
                clientId: "",
                name: contactName,
                phone: from,
                pipelineStatus: "aguardando_envio",
                lastMessage: text || `[${msg.type}]`,
                lastTime: nowISO(),
                unread: 1,
                createdAt: nowISO(),
                updatedAt: nowISO(),
              });

            conversationId = newConversationRef.id;
          }

          await saveMessage({
  conversationId,
  direction: "in",
  waMessageId: msg.id,
  from,
  contactName,
  type: msg.type,
  text,
  mediaId,
  mediaUrl,
  mimeType,
  fileName,
  raw: msg,
});
        }

        for (const status of statuses) {
          await db.collection("whatsapp_status").add({
            waMessageId: status.id,
            recipientId: status.recipient_id,
            status: status.status,
            timestamp: status.timestamp,
            raw: status,
            createdAt: nowISO(),
          });

          const sentMessages = await db
  .collection("whatsapp_mensagens")
  .where("waMessageId", "==", status.id)
  .limit(1)
  .get();

         if (!sentMessages.empty) {
  await sentMessages.docs[0].ref.set(
    {
      status: status.status,
      statusUpdatedAt: nowISO(),
    },
    { merge: true }
  );
}

const pendingRef = db.collection("whatsapp_template_pendentes").doc(status.id);
const pendingSnap = await pendingRef.get();



if (pendingSnap.exists) {
  const pending = pendingSnap.data();

  if (status.status === "failed") {
    await pendingRef.set(
      {
        status: "failed",
        failedAt: nowISO(),
        rawStatus: status,
        updatedAt: nowISO(),
      },
      { merge: true }
    );
  }

  if (["sent", "delivered", "read"].includes(status.status)) {
    const existingConversation = await db
      .collection("whatsapp_conversas")
      .where("phone", "==", pending.to)
      .limit(1)
      .get();

    let conversationId = "";

    if (!existingConversation.empty) {
      conversationId = existingConversation.docs[0].id;
    } else {
      const newConversationRef = await db.collection("whatsapp_conversas").add({
        clientId: pending.clientId || "",
        name: pending.nome || pending.to,
        phone: pending.to,
        product: pending.qtd || "",
        amount: "",
        address: `${pending.rua}, ${pending.cidade}, n° ${pending.n}`,
        pipelineStatus: "aguardando_envio",
        lastMessage: "Template: confirmar endereço",
        lastTime: nowISO(),
        unread: 0,
        createdAt: nowISO(),
        updatedAt: nowISO(),
      });

      conversationId = newConversationRef.id;
    }

    await saveMessage({
      conversationId,
      direction: "out",
      to: pending.to,
      clientId: pending.clientId || "",
      type: "template",
      templateName: pending.templateName || "confirmar_pedido",
      text: pending.textPreview,
      status: status.status,
      waMessageId: pending.waMessageId,
      waResponse: pending.waResponse,
    });

    if (pending.clientId) {
  const clienteRef = db.collection("clientes").doc(pending.clientId);
  const clienteSnap = await clienteRef.get();

  if (clienteSnap.exists) {
    const cliente = clienteSnap.data();
    const statusPedido = cliente.status_pedido;

    if (statusPedido === "Novo" || statusPedido === "Aberto") {
      await clienteRef.set(
        {
          status_pedido: "Andamento",
          updatedAt: nowISO(),
        },
        { merge: true }
      );
    }
  }
}

    await db.collection("whatsapp_conversas").doc(conversationId).set(
      {
        lastMessage: "Template: confirmar endereço",
        lastTime: nowISO(),
        updatedAt: nowISO(),
      },
      { merge: true }
    );

    await pendingRef.delete();
  }
}

        }
      }
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro webhook whatsapp:", error);
    return res.sendStatus(200);
  }
});

// ENVIAR TEXTO
// ENVIAR TEXTO
// ENVIAR TEXTO
router.post("/send-text", async (req, res) => {
  try {
    const { to, message, clientId, conversationId } = req.body;
    const normalizedTo = normalizeWaPhone(to);

    if (!normalizedTo || !message) {
      return res.status(400).json({
        success: false,
        error: "Campos obrigatórios: to, message",
      });
    }

    let finalConversationId = conversationId || "";

    if (!finalConversationId) {
      const existingConversation = await db
        .collection("whatsapp_conversas")
        .where("phone", "==", normalizedTo)
        .limit(1)
        .get();

      if (!existingConversation.empty) {
        finalConversationId = existingConversation.docs[0].id;
      }
    }

    const payload = {
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "text",
      text: {
        body: message,
      },
    };

    const response = await axios.post(
      `${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: graphHeaders() }
    );

    const waMessageId = response.data?.messages?.[0]?.id || "";

    if (!finalConversationId) {
      return res.status(400).json({
        success: false,
        error:
          "Conversa não encontrada. Para iniciar conversa com cliente novo, envie um template primeiro.",
        data: response.data,
      });
    }

    await db.collection("whatsapp_conversas").doc(finalConversationId).set(
      {
        clientId: clientId || "",
        phone: normalizedTo,
        lastMessage: message,
        lastTime: nowISO(),
        updatedAt: nowISO(),
      },
      { merge: true }
    );

    await saveMessage({
      conversationId: finalConversationId,
      direction: "out",
      to: normalizedTo,
      clientId: clientId || "",
      type: "text",
      text: message,
      status: "sent",
      waMessageId,
      waResponse: response.data,
    });

    return res.json({
      success: true,
      conversationId: finalConversationId,
      data: response.data,
    });
  } catch (error) {
    console.error("Erro send-text:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// ENVIAR TEMPLATE CONFIRMAR PEDIDO
// ENVIAR TEMPLATE CONFIRMAR PEDIDO
router.post("/send-template/confirmar-pedido", async (req, res) => {
  try {
    const {
      to,
      clientId,
      conversationId,
      nome,
      nome_rep,
      emprs,
      qtd,
      rua,
      cidade,
      n,
    } = req.body;

    const normalizedTo = normalizeWaPhone(to);

    if (!normalizedTo || !nome || !nome_rep || !emprs || !qtd || !rua || !cidade || !n) {
      return res.status(400).json({
        success: false,
        error: "Campos obrigatórios: to, nome, nome_rep, emprs, qtd, rua, cidade, n",
      });
    }

    let finalConversationId = conversationId || "";

    if (!finalConversationId) {
      const existingConversation = await db
        .collection("whatsapp_conversas")
        .where("phone", "==", normalizedTo)
        .limit(1)
        .get();

      if (!existingConversation.empty) {
        finalConversationId = existingConversation.docs[0].id;
      }
    }

    const payload = {
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "template",
      template: {
        name: "confirmar_pedido",
        language: { code: "pt_BR" },
        components: [
          {
            type: "header",
            parameters: [
              { type: "text", parameter_name: "nome", text: nome },
            ],
          },
          {
            type: "body",
            parameters: [
              { type: "text", parameter_name: "nome_rep", text: nome_rep },
              { type: "text", parameter_name: "emprs", text: emprs },
              { type: "text", parameter_name: "qtd", text: qtd },
              { type: "text", parameter_name: "rua", text: rua },
              { type: "text", parameter_name: "cidade", text: cidade },
              { type: "text", parameter_name: "n", text: n },
            ],
          },
        ],
      },
    };

    const response = await axios.post(
      `${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: graphHeaders() }
    );

    const waMessageId = response.data?.messages?.[0]?.id || "";

    const textPreview =
      `Olá, ${nome}!\n\n` +
      `Aqui é o ${nome_rep}, da equipe da ${emprs}. Recebemos seu pedido de ${qtd} e ele será entregue no endereço abaixo:\n\n` +
      `📍 Rua: ${rua}, ${cidade}, n° ${n}\n\n` +
      `Você confirma o endereço?`;

    if (finalConversationId) {
      await db.collection("whatsapp_conversas").doc(finalConversationId).set(
        {
          clientId: clientId || "",
          name: nome || normalizedTo,
          phone: normalizedTo,
          product: qtd || "",
          address: `${rua}, ${cidade}, n° ${n}`,
          lastMessage: "Template: confirmar endereço",
          lastTime: nowISO(),
          updatedAt: nowISO(),
        },
        { merge: true }
      );

      await saveMessage({
        conversationId: finalConversationId,
        direction: "out",
        to: normalizedTo,
        clientId: clientId || "",
        type: "template",
        templateName: "confirmar_pedido",
        text: textPreview,
        status: "sent",
        waMessageId,
        waResponse: response.data,
      });
    } else {
      await db.collection("whatsapp_template_pendentes").doc(waMessageId).set({
        waMessageId,
        to: normalizedTo,
        clientId: clientId || "",
        nome,
        nome_rep,
        emprs,
        qtd,
        rua,
        cidade,
        n,
        textPreview,
        templateName: "confirmar_pedido",
        status: "accepted",
        createdAt: nowISO(),
        updatedAt: nowISO(),
        waResponse: response.data,
      });
    }

    return res.json({
      success: true,
      conversationId: finalConversationId,
      pending: !finalConversationId,
      data: response.data,
    });
  } catch (error) {
    console.error("Erro confirmar_pedido:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// ENVIAR ÁUDIO
// ENVIAR ÁUDIO / VOICE NOTE
// ENVIAR ÁUDIO / VOICE NOTE
router.post("/send-audio", upload.single("audio"), async (req, res) => {
  try {
    const { to, clientId, conversationId } = req.body;
    const normalizedTo = normalizeWaPhone(to);

    if (!normalizedTo) {
      return res.status(400).json({
        success: false,
        error: "Campo obrigatório: to",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Áudio não enviado",
      });
    }

    let finalConversationId = conversationId || "";

    if (!finalConversationId) {
      const existingConversation = await db
        .collection("whatsapp_conversas")
        .where("phone", "==", normalizedTo)
        .limit(1)
        .get();

      if (!existingConversation.empty) {
        finalConversationId = existingConversation.docs[0].id;
      }
    }

    if (!finalConversationId) {
      return res.status(400).json({
        success: false,
        error:
          "Conversa não encontrada. Para enviar áudio, primeiro inicie a conversa com template.",
      });
    }

    const originalMimeType = req.file.mimetype || "";
    const originalName = req.file.originalname || "audio.webm";

    console.log("Áudio recebido:", {
      originalName,
      originalMimeType,
      size: req.file.size,
    });

    let audioBuffer = await convertAudioToOgg(req.file.buffer, originalName);
let uploadFileName = `audio-${Date.now()}.ogg`;
let uploadMimeType = "audio/ogg";

    const form = new FormData();

    form.append("messaging_product", "whatsapp");
    form.append("type", uploadMimeType);
    form.append("file", audioBuffer, {
      filename: uploadFileName,
      contentType: uploadMimeType,
    });

    const mediaResponse = await axios.post(
      `${GRAPH_URL}/${PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...form.getHeaders(),
        },
      }
    );

    const mediaId = mediaResponse.data.id;

    const payload = {
  messaging_product: "whatsapp",
  to: normalizedTo,
  type: "audio",
  audio: {
    id: mediaId,
  },
};

    const sendResponse = await axios.post(
      `${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`,
      payload,
      {
        headers: graphHeaders(),
      }
    );

    await db.collection("whatsapp_conversas").doc(finalConversationId).set(
      {
        clientId: clientId || "",
        phone: normalizedTo,
        lastMessage: "🎤 Áudio",
        lastTime: nowISO(),
        updatedAt: nowISO(),
      },
      { merge: true }
    );

    await saveMessage({
      conversationId: finalConversationId,
      direction: "out",
      to: normalizedTo,
      clientId: clientId || "",
      type: "audio",
      text: "🎤 Áudio",
      mediaId,
      mimeType: uploadMimeType,
      status: "sent",
      waMessageId: sendResponse.data?.messages?.[0]?.id || "",
      waResponse: sendResponse.data,
    });

    return res.json({
      success: true,
      conversationId: finalConversationId,
      mediaId,
      data: sendResponse.data,
    });
  } catch (error) {
    console.error("Erro send-audio:", {
      message: error.message,
      response: error.response?.data,
      stack: error.stack,
    });

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// LISTAR CONVERSAS
router.get("/conversations", async (req, res) => {
  try {
    const snapshot = await db
      .collection("whatsapp_conversas")
      .orderBy("updatedAt", "desc")
      .get();

    const conversations = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({ success: true, data: conversations });
  } catch (error) {
    console.error("Erro ao listar conversas:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// BUSCAR MENSAGENS DE UMA CONVERSA
router.get("/conversations/:conversationId/messages", async (req, res) => {
  try {
    const { conversationId } = req.params;

    const snapshot = await db
  .collection("whatsapp_mensagens")
  .where("conversationId", "==", conversationId)
  .get();

    const messages = snapshot.docs
  .map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }))
  .sort((a, b) => {
    const dateA = new Date(a.createdAt || 0).getTime();
    const dateB = new Date(b.createdAt || 0).getTime();
    return dateA - dateB;
  });

    return res.json({ success: true, data: messages });
  } catch (error) {
    console.error("Erro ao buscar mensagens:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// CRIAR OU ABRIR CONVERSA COM CLIENTE
router.post("/conversations/open", async (req, res) => {
  try {
    const {
      clientId,
      name,
      phone,
      product,
      amount,
      address,
      pipelineStatus = "aguardando_envio",
    } = req.body;

    if (!phone) {
      return res.status(400).json({
        success: false,
        error: "Campo obrigatório: phone",
      });
    }

    const existing = await db
      .collection("whatsapp_conversas")
      .where("phone", "==", phone)
      .limit(1)
      .get();

    if (!existing.empty) {
      const doc = existing.docs[0];

      return res.json({
        success: true,
        data: {
          id: doc.id,
          ...doc.data(),
        },
      });
    }

    const payload = {
      clientId: clientId || "",
      name: name || phone,
      phone,
      product: product || "",
      amount: amount || "",
      address: address || "",
      pipelineStatus,
      lastMessage: "",
      lastTime: "",
      unread: 0,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };

    const docRef = await db.collection("whatsapp_conversas").add(payload);

    return res.json({
      success: true,
      data: {
        id: docRef.id,
        ...payload,
      },
    });
  } catch (error) {
    console.error("Erro ao abrir conversa:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// LISTAR ATALHOS DE MENSAGEM
router.get("/shortcuts", async (req, res) => {
  try {
    const snapshot = await db
      .collection("whatsapp_atalhos")
      .orderBy("createdAt", "asc")
      .get();

    const shortcuts = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    return res.json({ success: true, data: shortcuts });
  } catch (error) {
    console.error("Erro ao listar atalhos:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// CRIAR ATALHO DE MENSAGEM
router.post("/shortcuts", async (req, res) => {
  try {
    const { title, type = "text", message, audioUrl, category = "geral" } = req.body;

    if (!title) {
      return res.status(400).json({
        success: false,
        error: "Campo obrigatório: title",
      });
    }

    const payload = {
      title,
      type,
      message: message || "",
      audioUrl: audioUrl || "",
      category,
      active: true,
      createdAt: nowISO(),
      updatedAt: nowISO(),
    };

    const docRef = await db.collection("whatsapp_atalhos").add(payload);

    return res.json({
      success: true,
      data: {
        id: docRef.id,
        ...payload,
      },
    });
  } catch (error) {
    console.error("Erro ao criar atalho:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ATUALIZAR STATUS DA CONVERSA
router.put("/conversations/:conversationId/status", async (req, res) => {
  try {
    const { conversationId } = req.params;
    const { pipelineStatus } = req.body;

    if (!pipelineStatus) {
      return res.status(400).json({
        success: false,
        error: "Campo obrigatório: pipelineStatus",
      });
    }

    await db.collection("whatsapp_conversas").doc(conversationId).update({
      pipelineStatus,
      updatedAt: nowISO(),
    });

    return res.json({ success: true });
  } catch (error) {
    console.error("Erro ao atualizar status:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// MARCAR CONVERSA COMO LIDA
router.put("/conversations/:conversationId/read", async (req, res) => {
  try {
    const { conversationId } = req.params;

    await db.collection("whatsapp_conversas").doc(conversationId).set(
      {
        unread: 0,
        readAt: nowISO(),
        updatedAt: nowISO(),
      },
      { merge: true }
    );

    return res.json({ success: true });
  } catch (error) {
    console.error("Erro ao marcar conversa como lida:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// PROXY PARA BAIXAR/EXIBIR MÍDIA DO WHATSAPP
router.get("/media/:mediaId", async (req, res) => {
  try {
    const { mediaId } = req.params;

    if (!mediaId) {
      return res.status(400).json({
        success: false,
        error: "mediaId obrigatório",
      });
    }

    const mediaInfoResponse = await axios.get(`${GRAPH_URL}/${mediaId}`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
      },
    });

    const mediaUrl = mediaInfoResponse.data?.url;
    const mimeType = mediaInfoResponse.data?.mime_type || "application/octet-stream";

    if (!mediaUrl) {
      return res.status(404).json({
        success: false,
        error: "URL da mídia não encontrada",
      });
    }

    const mediaFileResponse = await axios.get(mediaUrl, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
      },
      responseType: "stream",
    });

    res.setHeader("Content-Type", mimeType);
    res.setHeader("Cache-Control", "private, max-age=300");

    mediaFileResponse.data.pipe(res);
  } catch (error) {
    console.error("Erro ao buscar mídia:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// ENVIAR IMAGEM
// ENVIAR IMAGEM
// ENVIAR IMAGEM
router.post("/send-image", upload.single("image"), async (req, res) => {
  try {
    const { to, clientId, conversationId, caption } = req.body;
    const normalizedTo = normalizeWaPhone(to);

    if (!normalizedTo) {
      return res.status(400).json({
        success: false,
        error: "Campo obrigatório: to",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Imagem não enviada",
      });
    }

    let finalConversationId = conversationId || "";

    if (!finalConversationId) {
      const existingConversation = await db
        .collection("whatsapp_conversas")
        .where("phone", "==", normalizedTo)
        .limit(1)
        .get();

      if (!existingConversation.empty) {
        finalConversationId = existingConversation.docs[0].id;
      }
    }

    if (!finalConversationId) {
      return res.status(400).json({
        success: false,
        error:
          "Conversa não encontrada. Para enviar imagem, primeiro inicie a conversa com template.",
      });
    }

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", req.file.mimetype || "image/jpeg");
    form.append("file", req.file.buffer, {
      filename: req.file.originalname || "imagem.jpg",
      contentType: req.file.mimetype || "image/jpeg",
    });

    const mediaResponse = await axios.post(
      `${GRAPH_URL}/${PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...form.getHeaders(),
        },
      }
    );

    const mediaId = mediaResponse.data.id;

    const payload = {
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "image",
      image: {
        id: mediaId,
        caption: caption || "",
      },
    };

    const sendResponse = await axios.post(
      `${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: graphHeaders() }
    );

    await db.collection("whatsapp_conversas").doc(finalConversationId).set(
      {
        clientId: clientId || "",
        phone: normalizedTo,
        lastMessage: caption || "🖼️ Imagem",
        lastTime: nowISO(),
        updatedAt: nowISO(),
      },
      { merge: true }
    );

    await saveMessage({
      conversationId: finalConversationId,
      direction: "out",
      to: normalizedTo,
      clientId: clientId || "",
      type: "image",
      text: caption || "",
      mediaId,
      mimeType: req.file.mimetype || "image/jpeg",
      fileName: req.file.originalname || "",
      status: "sent",
      waMessageId: sendResponse.data?.messages?.[0]?.id || "",
      waResponse: sendResponse.data,
    });

    return res.json({
      success: true,
      conversationId: finalConversationId,
      mediaId,
      data: sendResponse.data,
    });
  } catch (error) {
    console.error("Erro send-image:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// ENVIAR DOCUMENTO
// ENVIAR DOCUMENTO
// ENVIAR DOCUMENTO
router.post("/send-document", upload.single("document"), async (req, res) => {
  try {
    const { to, clientId, conversationId, caption } = req.body;
    const normalizedTo = normalizeWaPhone(to);

    if (!normalizedTo) {
      return res.status(400).json({
        success: false,
        error: "Campo obrigatório: to",
      });
    }

    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "Documento não enviado",
      });
    }

    let finalConversationId = conversationId || "";

    if (!finalConversationId) {
      const existingConversation = await db
        .collection("whatsapp_conversas")
        .where("phone", "==", normalizedTo)
        .limit(1)
        .get();

      if (!existingConversation.empty) {
        finalConversationId = existingConversation.docs[0].id;
      }
    }

    if (!finalConversationId) {
      return res.status(400).json({
        success: false,
        error:
          "Conversa não encontrada. Para enviar documento, primeiro inicie a conversa com template.",
      });
    }

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", req.file.mimetype || "application/pdf");
    form.append("file", req.file.buffer, {
      filename: req.file.originalname || "documento.pdf",
      contentType: req.file.mimetype || "application/pdf",
    });

    const mediaResponse = await axios.post(
      `${GRAPH_URL}/${PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...form.getHeaders(),
        },
      }
    );

    const mediaId = mediaResponse.data.id;

    const payload = {
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "document",
      document: {
        id: mediaId,
        filename: req.file.originalname || "documento.pdf",
        caption: caption || "",
      },
    };

    const sendResponse = await axios.post(
      `${GRAPH_URL}/${PHONE_NUMBER_ID}/messages`,
      payload,
      { headers: graphHeaders() }
    );

    await db.collection("whatsapp_conversas").doc(finalConversationId).set(
      {
        clientId: clientId || "",
        phone: normalizedTo,
        lastMessage: `📄 ${req.file.originalname || "Documento"}`,
        lastTime: nowISO(),
        updatedAt: nowISO(),
      },
      { merge: true }
    );

    await saveMessage({
      conversationId: finalConversationId,
      direction: "out",
      to: normalizedTo,
      clientId: clientId || "",
      type: "document",
      text: caption || `📄 ${req.file.originalname || "Documento"}`,
      mediaId,
      mimeType: req.file.mimetype || "application/pdf",
      fileName: req.file.originalname || "",
      status: "sent",
      waMessageId: sendResponse.data?.messages?.[0]?.id || "",
      waResponse: sendResponse.data,
    });

    return res.json({
      success: true,
      conversationId: finalConversationId,
      mediaId,
      data: sendResponse.data,
    });
  } catch (error) {
    console.error("Erro send-document:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// VERIFICAR SE JÁ EXISTE CONVERSA
router.get("/conversations/find", async (req, res) => {
  try {
    const { phone, clientId } = req.query;
    const normalizedPhone = normalizeWaPhone(phone || "");

    if (!normalizedPhone && !clientId) {
      return res.status(400).json({
        success: false,
        error: "Informe phone ou clientId",
      });
    }

    let snapshot = null;

    if (clientId) {
      snapshot = await db
        .collection("whatsapp_conversas")
        .where("clientId", "==", String(clientId))
        .limit(1)
        .get();
    }

    if ((!snapshot || snapshot.empty) && normalizedPhone) {
      snapshot = await db
        .collection("whatsapp_conversas")
        .where("phone", "==", normalizedPhone)
        .limit(1)
        .get();
    }

    if (!snapshot || snapshot.empty) {
      return res.json({
        success: true,
        exists: false,
        data: null,
      });
    }

    const doc = snapshot.docs[0];

    return res.json({
      success: true,
      exists: true,
      data: {
        id: doc.id,
        ...doc.data(),
      },
    });
  } catch (error) {
    console.error("Erro ao buscar conversa:", error);
    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;