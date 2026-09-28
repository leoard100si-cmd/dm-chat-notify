// Alternativa 100% GRÁTIS ao Cloud Functions — não precisa de plano Blaze
// nem de cartão de crédito. É um script Node.js que fica rodando num
// servidor grátis (Render.com) escutando o banco de dados e mandando a
// notificação push toda vez que chega mensagem nova.
//
// A chave da service account vem de uma variável de ambiente
// (FIREBASE_SERVICE_ACCOUNT), não de um arquivo — assim dá pra rodar no
// Render sem subir esse arquivo sensível pro GitHub.
//
// Também sobe um servidorzinho HTTP mínimo, só pra responder "OK" — é o
// que permite usar o plano Web Service grátis do Render (que exige um
// serviço com porta HTTP) em vez do "background worker", que é pago lá.

const http = require("http");
const admin = require("firebase-admin");

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://dmchat-8a532-default-rtdb.firebaseio.com"
});

// Servidor HTTP só pra responder ao "pinger" (UptimeRobot/cron-job.org)
// e manter o serviço acordado no Render.
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Notificador do D.M rodando");
}).listen(PORT, () => console.log("Servidor de saúde na porta " + PORT));

const db = admin.database();
const messaging = admin.messaging();

// Mesma lista de usuários do dm-chat.html (mantenha as duas em sincronia).
const FIXED_USERS = ["NightFall", "Flamenguista", "Kaw", "Leo", "Khotoziko", "Sheikada", "eren", "Hinata", "johnny"];

// Fixos + quem entrou por convite (members/). Lê com a service account,
// então funciona mesmo com as regras do Firebase fechadas.
async function allUsers() {
  const snap = await db.ref("members").once("value");
  return Array.from(new Set(FIXED_USERS.concat(Object.keys(snap.val() || {}))));
}

function previewText(m) {
  if (m.type === "text") return m.text;
  if (m.type === "image") return "enviou uma foto";
  if (m.type === "video") return "enviou um vídeo";
  if (m.type === "audio") return "enviou um áudio";
  return "enviou um arquivo";
}

// Escreve em notify/<usuário> toda vez que chega mensagem nova pra ele.
// É esse caminho que a extensão "Push Notification Pro" do Kodular vigia
// (ValueEventListener no Realtime Database) para disparar a notificação
// nativa no app Android, mesmo com o app fechado — sem precisar de token
// FCM, certificado ou chave de servidor.
async function writeNotifyPath(username, title, body, dataChat) {
  await db.ref("notify/" + username).set({
    title,
    body,
    chat: dataChat,
    timestamp: Date.now()
  });
}

// Manda notificação NATIVA pro app Android via Kodular. Diferente do
// bloco de web push acima, aqui mandamos o campo "notification" junto
// (não só "data"): mensagens desse tipo são entregues pelo próprio
// Google Play Services e aparecem na barra de status sozinhas, MESMO
// com o app fechado — sem precisar de extensão paga nem do app estar
// rodando pra processar nada. O token vem de androidTokens/<usuário>,
// que o app Kodular escreve quando o usuário loga.
async function sendToAndroid(username, title, body, dataChat) {
  const tokenSnap = await db.ref("androidTokens/" + username).once("value");
  const token = tokenSnap.val();
  if (!token) return;

  try {
    await messaging.send({
      token,
      notification: { title, body },
      data: { chat: dataChat },
      android: { priority: "high" }
    });
  } catch (err) {
    // Token inválido (app desinstalado, dados limpos, etc.) — remove.
    if (err.code === "messaging/registration-token-not-registered" ||
        err.code === "messaging/invalid-registration-token") {
      await db.ref("androidTokens/" + username).remove();
    } else {
      console.error("Erro mandando notificação Android pra " + username + ":", err.message);
    }
  }
}

async function sendToUser(username, title, body, dataChat) {
  // Sempre escreve o caminho de notificação nativa (reserva/uso futuro).
  await writeNotifyPath(username, title, body, dataChat);

  // Notificação nativa Android (Kodular) — funciona com app fechado.
  await sendToAndroid(username, title, body, dataChat);

  const tokensSnap = await db.ref("tokens/" + username).once("value");
  const tokens = Object.keys(tokensSnap.val() || {});
  if (tokens.length === 0) return;

  // Manda só "data" (sem o campo "notification"): se mandar os dois juntos,
  // o navegador mostra a notificação sozinho E o firebase-messaging-sw.js
  // mostra de novo manualmente, duplicando o aviso.
  const response = await messaging.sendEachForMulticast({
    tokens,
    data: { title, body, chat: dataChat },
    webpush: { fcmOptions: { link: "./" } }
  });

  // Remove tokens inválidos (app desinstalado, permissão revogada, etc.)
  const removals = [];
  response.responses.forEach((r, i) => {
    if (!r.success) removals.push(db.ref("tokens/" + username + "/" + tokens[i]).remove());
  });
  await Promise.all(removals);
}

// Evita disparar notificação de mensagens antigas quando o script liga.
const startedAt = Date.now();

db.ref("messages/general").on("child_added", async snap => {
  const m = snap.val();
  if (!m || !m.from || m.timestamp < startedAt) return;
  const recipients = (await allUsers()).filter(u => u !== m.from);
  const body = previewText(m);
  await Promise.all(recipients.map(u => sendToUser(u, "Geral · " + m.from, body, "general")));
});

// Escuta cada conversa privada que já existe e as que forem criadas depois.
db.ref("messages/private").on("child_added", chatSnap => {
  const chatId = chatSnap.key;
  db.ref("messages/private/" + chatId).on("child_added", async snap => {
    const m = snap.val();
    if (!m || !m.from || m.timestamp < startedAt) return;
    const [a, b] = chatId.split("_");
    const to = m.from === a ? b : a;
    if (!to || to === m.from) return;
    const body = previewText(m);
    await sendToUser(to, m.from, body, chatId);
  });
});

console.log("Notificador do Đ.M rodando... deixe essa janela/terminal aberto.");
