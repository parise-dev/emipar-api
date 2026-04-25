const express = require("express");
const axios = require("axios");
const multer = require("multer");
const FormData = require("form-data");
const db = require("../firebase");

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
          const from = msg.from;
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
router.post("/send-text", async (req, res) => {
  try {
    const { to, message, clientId, conversationId } = req.body;

    if (!to || !message) {
      return res.status(400).json({
        success: false,
        error: "Campos obrigatórios: to, message",
      });
    }

    let finalConversationId = conversationId || "";

    if (!finalConversationId) {
      const existingConversation = await db
        .collection("whatsapp_conversas")
        .where("phone", "==", to)
        .limit(1)
        .get();

      if (!existingConversation.empty) {
        finalConversationId = existingConversation.docs[0].id;
      } else {
        const newConversationRef = await db.collection("whatsapp_conversas").add({
          clientId: clientId || "",
          name: to,
          phone: to,
          pipelineStatus: "aguardando_envio",
          lastMessage: "",
          lastTime: "",
          unread: 0,
          createdAt: nowISO(),
          updatedAt: nowISO(),
        });

        finalConversationId = newConversationRef.id;
      }
    }

    const payload = {
      messaging_product: "whatsapp",
      to,
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

    await db.collection("whatsapp_conversas").doc(finalConversationId).set(
      {
        clientId: clientId || "",
        phone: to,
        lastMessage: message,
        lastTime: nowISO(),
        updatedAt: nowISO(),
      },
      { merge: true }
    );

   await saveMessage({
  conversationId: finalConversationId,
  direction: "out",
  to,
  clientId: clientId || "",
  type: "text",
  text: message,
  status: "sent",
  waMessageId: response.data?.messages?.[0]?.id || "",
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

    if (!to || !nome || !nome_rep || !emprs || !qtd || !rua || !cidade || !n) {
      return res.status(400).json({
        success: false,
        error:
          "Campos obrigatórios: to, nome, nome_rep, emprs, qtd, rua, cidade, n",
      });
    }

    let finalConversationId = conversationId || "";

    if (!finalConversationId) {
      const existingConversation = await db
        .collection("whatsapp_conversas")
        .where("phone", "==", to)
        .limit(1)
        .get();

      if (!existingConversation.empty) {
        finalConversationId = existingConversation.docs[0].id;
      }
    }

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: "confirmar_pedido",
        language: {
          code: "pt_BR",
        },
        components: [
  {
    type: "header",
    parameters: [
      { type: "text", text: nome },
    ],
  },
  {
    type: "body",
    parameters: [
      { type: "text", text: nome_rep },
      { type: "text", text: emprs },
      { type: "text", text: qtd },
      { type: "text", text: rua },
      { type: "text", text: cidade },
      { type: "text", text: n },
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

    const textPreview = `Olá, ${nome}!\n\nAqui é o ${nome_rep}, da equipe da ${emprs}. Recebemos seu pedido de ${qtd} e ele será entregue no endereço abaixo:\n\n📍 Rua: ${rua}, ${cidade}, n° ${n}\n\nVocê confirma o endereço?`;

    if (finalConversationId) {
      await db.collection("whatsapp_conversas").doc(finalConversationId).set(
        {
          clientId: clientId || "",
          phone: to,
          lastMessage: "Template: confirmar pedido",
          lastTime: nowISO(),
          updatedAt: nowISO(),
        },
        { merge: true }
      );
    }

    await saveMessage({
      conversationId: finalConversationId,
      direction: "out",
      to,
      clientId: clientId || "",
      type: "template",
      templateName: "confirmar_pedido",
      text: textPreview,
      status: "sent",
      waMessageId: response.data?.messages?.[0]?.id || "",
      waResponse: response.data,
    });

    return res.json({
      success: true,
      conversationId: finalConversationId,
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
router.post("/send-audio", upload.single("audio"), async (req, res) => {
  try {
    const { to, clientId, conversationId } = req.body;

    if (!to) {
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
        .where("phone", "==", to)
        .limit(1)
        .get();

      if (!existingConversation.empty) {
        finalConversationId = existingConversation.docs[0].id;
      } else {
        const newConversationRef = await db.collection("whatsapp_conversas").add({
          clientId: clientId || "",
          name: to,
          phone: to,
          pipelineStatus: "aguardando_envio",
          lastMessage: "",
          lastTime: "",
          unread: 0,
          createdAt: nowISO(),
          updatedAt: nowISO(),
        });

        finalConversationId = newConversationRef.id;
      }
    }

    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", req.file.mimetype || "audio/ogg");
    form.append("file", req.file.buffer, {
      filename: req.file.originalname || "audio.ogg",
      contentType: req.file.mimetype || "audio/ogg",
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

    const isVoiceNote =
      (req.file.originalname || "").endsWith(".ogg") ||
      (req.file.mimetype || "").includes("ogg");

    const payload = {
      messaging_product: "whatsapp",
      to,
      type: "audio",
      audio: {
        id: mediaId,
        voice: isVoiceNote,
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
        phone: to,
        lastMessage: "🎤 Áudio",
        lastTime: nowISO(),
        updatedAt: nowISO(),
      },
      { merge: true }
    );

    await saveMessage({
      conversationId: finalConversationId,
      direction: "out",
      to,
      clientId: clientId || "",
      type: "audio",
      text: "🎤 Áudio",
      mediaId,
      mimeType: req.file.mimetype || "audio/ogg",
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
    console.error("Erro send-audio:", error.response?.data || error.message);

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
router.post("/send-image", upload.single("image"), async (req, res) => {
  try {
    const { to, clientId, conversationId, caption } = req.body;

    if (!to) {
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
        .where("phone", "==", to)
        .limit(1)
        .get();

      if (!existingConversation.empty) {
        finalConversationId = existingConversation.docs[0].id;
      }
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
      to,
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
        phone: to,
        lastMessage: caption || "🖼️ Imagem",
        lastTime: nowISO(),
        updatedAt: nowISO(),
      },
      { merge: true }
    );

    await saveMessage({
      conversationId: finalConversationId,
      direction: "out",
      to,
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
router.post("/send-document", upload.single("document"), async (req, res) => {
  try {
    const { to, clientId, conversationId, caption } = req.body;

    if (!to) {
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
        .where("phone", "==", to)
        .limit(1)
        .get();

      if (!existingConversation.empty) {
        finalConversationId = existingConversation.docs[0].id;
      }
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
      to,
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
        phone: to,
        lastMessage: `📄 ${req.file.originalname || "Documento"}`,
        lastTime: nowISO(),
        updatedAt: nowISO(),
      },
      { merge: true }
    );

    await saveMessage({
      conversationId: finalConversationId,
      direction: "out",
      to,
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

module.exports = router;