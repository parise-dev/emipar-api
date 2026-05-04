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
  const outputPath = path.join(tempDir, `voice-${timestamp}.ogg`);

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
        "-frame_duration 20",
        "-vbr on",
        "-compression_level 10",
        "-avoid_negative_ts make_zero",
        "-map_metadata -1",
      ])
      .on("end", resolve)
      .on("error", reject)
      .save(outputPath);
  });

  const convertedBuffer = fs.readFileSync(outputPath);

  const debugPath = path.join(tempDir, `debug-last-whatsapp-voice.ogg`);
  fs.writeFileSync(debugPath, convertedBuffer);

  console.log("Áudio convertido salvo para debug:", {
    debugPath,
    size: convertedBuffer.length,
  });

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

function getBrazilPhoneVariants(phone = "") {
  const normalized = normalizeWaPhone(phone);

  if (!normalized) return [];

  const variants = new Set();

  variants.add(normalized);

  if (normalized.startsWith("55")) {
    const country = "55";
    const ddd = normalized.slice(2, 4);
    const number = normalized.slice(4);

    if (ddd.length === 2 && number.length === 9 && number.startsWith("9")) {
      variants.add(`${country}${ddd}${number.slice(1)}`);
    }

    if (ddd.length === 2 && number.length === 8) {
      variants.add(`${country}${ddd}9${number}`);
    }
  }

  return Array.from(variants);
}

async function findConversationByPhone(phone = "") {
  const variants = getBrazilPhoneVariants(phone);

  if (!variants.length) {
    return null;
  }

  const snapshot = await db
    .collection("whatsapp_conversas")
    .where("phone", "in", variants.slice(0, 10))
    .limit(1)
    .get();

  if (snapshot.empty) {
    return null;
  }

  return snapshot.docs[0];
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
let messageType = msg.type || "unknown";

let reactionToWaMessageId = "";
let reactionTargetText = "";
let reactionTargetType = "";
let reactionTargetFromMe = false;

if (messageType === "text") {
  /**
   * Mensagem normal de texto.
   * Emoji comum também chega aqui, exemplo:
   * "👍", "😂", "❤️", "Bom dia 😄"
   */
  text = msg.text?.body || "";
}

if (messageType === "button") {
  text = msg.button?.text || msg.button?.payload || "Botão clicado";
}

if (messageType === "interactive") {
  text =
    msg.interactive?.button_reply?.title ||
    msg.interactive?.button_reply?.id ||
    msg.interactive?.list_reply?.title ||
    msg.interactive?.list_reply?.id ||
    "Resposta interativa";
}

if (messageType === "reaction") {
  const emoji = msg.reaction?.emoji || "";
  const reactedMessageId = msg.reaction?.message_id || "";

  reactionToWaMessageId = reactedMessageId;

  text = emoji ? `Reagiu com ${emoji}` : "Removeu uma reação";
}

if (messageType === "sticker") {
  mediaId = msg.sticker?.id || "";
  mimeType = msg.sticker?.mime_type || "";
  text = "Figurinha recebida";
}

if (messageType === "audio") {
  mediaId = msg.audio?.id || "";
  mimeType = msg.audio?.mime_type || "";
  text = "🎤 Áudio recebido";
}

if (messageType === "image") {
  mediaId = msg.image?.id || "";
  mimeType = msg.image?.mime_type || "";
  text = msg.image?.caption || "🖼️ Imagem recebida";
}

if (messageType === "document") {
  mediaId = msg.document?.id || "";
  mimeType = msg.document?.mime_type || "";
  fileName = msg.document?.filename || "";
  text =
    msg.document?.caption ||
    `📄 Documento recebido${fileName ? `: ${fileName}` : ""}`;
}

if (messageType === "video") {
  mediaId = msg.video?.id || "";
  mimeType = msg.video?.mime_type || "";
  text = msg.video?.caption || "🎥 Vídeo recebido";
}

if (messageType === "location") {
  const latitude = msg.location?.latitude;
  const longitude = msg.location?.longitude;
  const name = msg.location?.name || "";
  const address = msg.location?.address || "";

  text = `📍 Localização recebida${name ? `: ${name}` : ""}${
    address ? ` - ${address}` : ""
  }`;

  fileName =
    latitude && longitude
      ? `${latitude},${longitude}`
      : "";
}

if (messageType === "contacts") {
  const receivedContacts = msg.contacts || [];
  const firstContact = receivedContacts[0];

  const contactReceivedName =
    firstContact?.name?.formatted_name ||
    firstContact?.name?.first_name ||
    firstContact?.name?.last_name ||
    "Contato";

  const firstPhone =
    firstContact?.phones?.[0]?.phone ||
    firstContact?.phones?.[0]?.wa_id ||
    "";

  text = `👤 Contato recebido: ${contactReceivedName}${
    firstPhone ? ` - ${firstPhone}` : ""
  }`;
}

if (messageType === "order") {
  text = "🛒 Pedido recebido pelo WhatsApp";
}

if (messageType === "system") {
  text = msg.system?.body || "Mensagem de sistema recebida";
}

if (messageType === "unsupported") {
  text = "Mensagem não suportada pelo WhatsApp Business API";
}

/**
 * Segurança extra:
 * se vier algum tipo novo da Meta que ainda não tratamos,
 * não deixa a conversa aparecer vazia.
 */
if (!text) {
  text = `[${messageType || "mensagem"} recebida]`;
}
          if (mediaId) {
            try {
              mediaUrl = await getWhatsappMediaUrl(mediaId);
            } catch (mediaError) {
              console.error(
                "Erro ao buscar URL da mídia:",
                mediaError.response?.data || mediaError.message
              );
            }
          }

          const existingConversationDoc = await findConversationByPhone(from);

          let conversationId = "";

          if (existingConversationDoc) {
            conversationId = existingConversationDoc.id;

            if (messageType === "reaction" && reactionToWaMessageId) {
  try {
    const reactedMessageSnapshot = await db
      .collection("whatsapp_mensagens")
      .where("conversationId", "==", conversationId)
      .where("waMessageId", "==", reactionToWaMessageId)
      .limit(1)
      .get();

    if (!reactedMessageSnapshot.empty) {
      const reactedMessage = reactedMessageSnapshot.docs[0].data();

      reactionTargetText =
        reactedMessage.text ||
        reactedMessage.fileName ||
        reactedMessage.templateName ||
        reactedMessage.type ||
        "Mensagem";

      reactionTargetType = reactedMessage.type || "";
      reactionTargetFromMe = reactedMessage.direction === "out";
    }
  } catch (error) {
    console.error("Erro ao buscar mensagem da reação:", error.message);
  }
}

            await db.collection("whatsapp_conversas").doc(conversationId).set(
              {
                name: contactName,
                phone: existingConversationDoc.data().phone || from,
                whatsappPhone: from,
                phoneVariants: getBrazilPhoneVariants(from),
                lastMessage: reactionTargetText
  ? `${text}: ${reactionTargetText.slice(0, 40)}`
  : text,
                lastTime: nowISO(),
                unread: (existingConversationDoc.data().unread || 0) + 1,
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
                whatsappPhone: from,
                phoneVariants: getBrazilPhoneVariants(from),
                pipelineStatus: "aguardando_envio",
                lastMessage: reactionTargetText
  ? `${text}: ${reactionTargetText.slice(0, 40)}`
  : text,
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
  type: messageType,
  text,
  mediaId,
  mediaUrl,
  mimeType,
  fileName,

  reactionToWaMessageId,
  reactionTargetText,
  reactionTargetType,
  reactionTargetFromMe,

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

          const pendingRef = db
            .collection("whatsapp_template_pendentes")
            .doc(status.id);

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
              const existingConversationDoc = await findConversationByPhone(
                pending.to
              );

              let conversationId = "";

              if (existingConversationDoc) {
                conversationId = existingConversationDoc.id;
              } else {
                const newConversationRef = await db
                  .collection("whatsapp_conversas")
                  .add({
                    clientId: pending.clientId || "",
                    name: pending.nome || pending.to,
                    phone: pending.to,
                    whatsappPhone: pending.to,
                    phoneVariants: getBrazilPhoneVariants(pending.to),
                    product: pending.qtd || "",
                    amount: "",
                    address:
                      pending.rua && pending.cidade && pending.n
                        ? `${pending.rua}, ${pending.cidade}, n° ${pending.n}`
                        : "",
                    codigo_rastreio: pending.codigo_rastreio || "",
                    pipelineStatus: "aguardando_envio",
                    lastMessage:
                      pending.templateName === "cod_rastreio"
                        ? "Template: código de rastreio"
                        : "Template: confirmar endereço",
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
                const clienteRef = db
                  .collection("clientes")
                  .doc(pending.clientId);

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
                  codigo_rastreio: pending.codigo_rastreio || "",
                  phoneVariants: getBrazilPhoneVariants(pending.to),
                  lastMessage:
                    pending.templateName === "cod_rastreio"
                      ? "Template: código de rastreio"
                      : "Template: confirmar endereço",
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
      const existingConversationDoc = await findConversationByPhone(
        normalizedTo
      );

      if (existingConversationDoc) {
        finalConversationId = existingConversationDoc.id;
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
        whatsappPhone: normalizedTo,
        phoneVariants: getBrazilPhoneVariants(normalizedTo),
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
      status: "accepted",
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

    if (
      !normalizedTo ||
      !nome ||
      !nome_rep ||
      !emprs ||
      !qtd ||
      !rua ||
      !cidade ||
      !n
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Campos obrigatórios: to, nome, nome_rep, emprs, qtd, rua, cidade, n",
      });
    }

    let finalConversationId = conversationId || "";

    if (!finalConversationId) {
      const existingConversationDoc = await findConversationByPhone(
        normalizedTo
      );

      if (existingConversationDoc) {
        finalConversationId = existingConversationDoc.id;
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
            parameters: [{ type: "text", parameter_name: "nome", text: nome }],
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
          whatsappPhone: normalizedTo,
          phoneVariants: getBrazilPhoneVariants(normalizedTo),
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
        status: "accepted",
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
    console.error(
      "Erro confirmar_pedido:",
      error.response?.data || error.message
    );

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

// ENVIAR TEMPLATE CÓDIGO DE RASTREIO
router.post("/send-template/cod-rastreio", async (req, res) => {
  try {
    const { to, clientId, conversationId, nome, codigo_rastreio } = req.body;

    const normalizedTo = normalizeWaPhone(to);

    if (!normalizedTo) {
      return res.status(400).json({
        success: false,
        error: "Campo obrigatório: to",
      });
    }

    let finalConversationId = conversationId || "";
    let finalNome = nome || "";
    let finalCodigoRastreio = "";

    if (clientId) {
      const clienteRef = db.collection("clientes").doc(String(clientId));
      const clienteSnap = await clienteRef.get();

      if (clienteSnap.exists) {
        const cliente = clienteSnap.data();

        finalNome =
          cliente.nome || cliente.name || cliente.cliente || finalNome || "";

        finalCodigoRastreio =
          cliente.codigo_rastreio ||
          cliente.cod_rastreio ||
          cliente.rastreio ||
          cliente.codigoRastreio ||
          "";
      }
    }

    if (!finalCodigoRastreio) {
      finalCodigoRastreio = codigo_rastreio || "";
    }

    if (!finalNome) {
      finalNome = normalizedTo;
    }

    if (!finalCodigoRastreio) {
      return res.status(400).json({
        success: false,
        error:
          "Código de rastreio não encontrado para esse cliente. Verifique se o pedido possui codigo_rastreio.",
      });
    }

    if (!finalConversationId) {
      const existingConversationDoc = await findConversationByPhone(
        normalizedTo
      );

      if (existingConversationDoc) {
        finalConversationId = existingConversationDoc.id;
      }
    }

    if (finalConversationId) {
  const recentTemplateSnapshot = await db
    .collection("whatsapp_mensagens")
    .where("conversationId", "==", finalConversationId)
    .where("templateName", "==", "cod_rastreio")
    .limit(10)
    .get();

  if (!recentTemplateSnapshot.empty) {
    const templates = recentTemplateSnapshot.docs
      .map((doc) => doc.data())
      .sort((a, b) => {
        const dateA = new Date(a.createdAt || 0).getTime();
        const dateB = new Date(b.createdAt || 0).getTime();

        return dateB - dateA;
      });

    const lastTemplate = templates[0];
    const lastCreatedAt = new Date(lastTemplate.createdAt || 0).getTime();
    const now = Date.now();

    const diffSeconds = (now - lastCreatedAt) / 1000;

    if (diffSeconds < 30) {
      return res.status(409).json({
        success: false,
        error:
          "Esse template de rastreio já foi enviado há poucos segundos. Aguarde antes de enviar novamente.",
      });
    }
  }
}

    const payload = {
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "template",
      template: {
        name: "cod_rastreio",
        language: { code: "pt_BR" },
        components: [
          {
            type: "body",
            parameters: [
              {
                type: "text",
                text: finalNome,
              },
              {
                type: "text",
                text: finalCodigoRastreio,
              },
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
      `Tenho uma ótima noticia, ${finalNome}.\n\n` +
      `Seu pedido foi despachado com sucesso!\n` +
      `Você pode acompanhar o envio: https://www.loggi.com/rastreador/${finalCodigoRastreio}\n\n` +
      `Qualquer dúvida estou á disposição!`;

    if (finalConversationId) {
      await db.collection("whatsapp_conversas").doc(finalConversationId).set(
        {
          clientId: clientId || "",
          name: finalNome || normalizedTo,
          phone: normalizedTo,
          whatsappPhone: normalizedTo,
          phoneVariants: getBrazilPhoneVariants(normalizedTo),
          codigo_rastreio: finalCodigoRastreio,
          lastMessage: "Template: código de rastreio",
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
        templateName: "cod_rastreio",
        text: textPreview,
        status: "accepted",
        waMessageId,
        waResponse: response.data,
      });
    } else {
      await db.collection("whatsapp_template_pendentes").doc(waMessageId).set({
        waMessageId,
        to: normalizedTo,
        clientId: clientId || "",
        nome: finalNome,
        codigo_rastreio: finalCodigoRastreio,
        textPreview,
        templateName: "cod_rastreio",
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
    console.error("Erro cod_rastreio:", error.response?.data || error.message);

    return res.status(500).json({
      success: false,
      error: error.response?.data || error.message,
    });
  }
});

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
      const existingConversationDoc = await findConversationByPhone(
        normalizedTo
      );

      if (existingConversationDoc) {
        finalConversationId = existingConversationDoc.id;
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

    const audioBuffer = await convertAudioToOgg(req.file.buffer, originalName);
    const uploadFileName = `voice-${Date.now()}.ogg`;
    const uploadMimeType = "audio/ogg";

    const form = new FormData();

    form.append("messaging_product", "whatsapp");
    form.append("type", uploadMimeType);
    form.append("file", audioBuffer, {
      filename: uploadFileName,
      contentType: uploadMimeType,
      knownLength: audioBuffer.length,
    });

    const mediaResponse = await axios.post(
      `${GRAPH_URL}/${PHONE_NUMBER_ID}/media`,
      form,
      {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
      }
    );

    const mediaId = mediaResponse.data.id;

    const payload = {
      messaging_product: "whatsapp",
      to: normalizedTo,
      type: "audio",
      audio: {
        id: mediaId,
        voice: true,
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
        whatsappPhone: normalizedTo,
        phoneVariants: getBrazilPhoneVariants(normalizedTo),
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
      status: "accepted",
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

    const conversations = await Promise.all(
      snapshot.docs.map(async (doc) => {
        const conversa = {
          id: doc.id,
          ...doc.data(),
        };

        if (!conversa.clientId) {
          return conversa;
        }

        try {
          const clienteDoc = await db
            .collection("clientes")
            .doc(String(conversa.clientId))
            .get();

          if (!clienteDoc.exists) {
            return conversa;
          }

          const cliente = clienteDoc.data() || {};

          return {
            ...conversa,
            name: conversa.name || cliente.nome || cliente.name || "",
            phone: conversa.phone || cliente.phone || "",
            product: conversa.product || cliente.produto || cliente.product || "",
            amount: conversa.amount || cliente.valor_total || "",
            address: conversa.address || cliente.endereco || "",
            codigo_rastreio:
              conversa.codigo_rastreio ||
              cliente.codigo_rastreio ||
              cliente.cod_rastreio ||
              cliente.rastreio ||
              cliente.codigoRastreio ||
              "",
          };
        } catch (clienteError) {
          console.error("Erro ao buscar cliente da conversa:", {
            conversationId: doc.id,
            clientId: conversa.clientId,
            error: clienteError.message,
          });

          return conversa;
        }
      })
    );

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

    const normalizedPhone = normalizeWaPhone(phone);
    const existingDoc = await findConversationByPhone(normalizedPhone);

    if (existingDoc) {
      return res.json({
        success: true,
        data: {
          id: existingDoc.id,
          ...existingDoc.data(),
        },
      });
    }

    const payload = {
      clientId: clientId || "",
      name: name || normalizedPhone,
      phone: normalizedPhone,
      whatsappPhone: normalizedPhone,
      phoneVariants: getBrazilPhoneVariants(normalizedPhone),
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
    const { title, type = "text", message, audioUrl, category = "geral" } =
      req.body;

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

// MARCAR CONVERSA COMO NÃO LIDA
router.put("/conversations/:conversationId/unread", async (req, res) => {
  try {
    const { conversationId } = req.params;

    await db.collection("whatsapp_conversas").doc(conversationId).set(
      {
        unread: 1,
        unreadMarkedManually: true,
        unreadMarkedAt: nowISO(),
        updatedAt: nowISO(),
      },
      { merge: true }
    );

    return res.json({ success: true });
  } catch (error) {
    console.error("Erro ao marcar conversa como não lida:", error);

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
    const mimeType =
      mediaInfoResponse.data?.mime_type || "application/octet-stream";

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
      const existingConversationDoc = await findConversationByPhone(
        normalizedTo
      );

      if (existingConversationDoc) {
        finalConversationId = existingConversationDoc.id;
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
        whatsappPhone: normalizedTo,
        phoneVariants: getBrazilPhoneVariants(normalizedTo),
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
      status: "accepted",
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
      const existingConversationDoc = await findConversationByPhone(
        normalizedTo
      );

      if (existingConversationDoc) {
        finalConversationId = existingConversationDoc.id;
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
        whatsappPhone: normalizedTo,
        phoneVariants: getBrazilPhoneVariants(normalizedTo),
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
      status: "accepted",
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
    let foundDoc = null;

    if (clientId) {
      snapshot = await db
        .collection("whatsapp_conversas")
        .where("clientId", "==", String(clientId))
        .limit(1)
        .get();
    }

    if (snapshot && !snapshot.empty) {
      foundDoc = snapshot.docs[0];
    }

    if (!foundDoc && normalizedPhone) {
      foundDoc = await findConversationByPhone(normalizedPhone);
    }

    if (!foundDoc) {
      return res.json({
        success: true,
        exists: false,
        data: null,
      });
    }

    return res.json({
      success: true,
      exists: true,
      data: {
        id: foundDoc.id,
        ...foundDoc.data(),
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